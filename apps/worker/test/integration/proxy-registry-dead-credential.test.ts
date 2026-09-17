import { env } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Env as WorkerEnv } from '../../src/env'
import { UpstreamProxyRegistry } from '../../src/mcp/proxy-registry'
import { UpstreamOAuthProvider } from '../../src/upstream/oauth-provider'
import type { UpstreamClient } from '../../src/upstream/upstream-client'
import type { UpstreamServerRow } from '../../src/db/queries/upstreams'
import { markReauthRequired } from '../../src/db/queries/upstream-credentials'
import type { RecordUsageArgs } from '../../src/usage/record'

/**
 * "Make a dead upstream loud" (2026-09-17 field finding).
 *
 * Upstream authorizations die on the provider's clock (Datadog 14d, Linear
 * ~25d, Sentry 30d). The registry used to SKIP an upstream whose credential
 * yielded no bearer, so its tools silently vanished from the session: the
 * agent had nothing to call and improvised, and users reconnected the MCP connector
 * every morning — which fixes nothing. These pin the replacement behaviour:
 *
 *   - the tools stay LISTED (from the cached catalogue, no dial);
 *   - every call fails with first-party `credential_revoked` recovery text,
 *     and that failure is RECORDED in usage (it used to return before
 *     stageUsage, hiding exactly the users who needed help);
 *   - once the user re-authorizes in the browser, the very next call works —
 *     the handler binds on demand, no reload_upstreams / reconnect needed;
 *   - a live session rebinds when the stored credential changes under it
 *     (renew, or a refresh by another session) instead of calling on with a
 *     superseded token;
 *   - refresh() reports recovered / still-unbound upstreams truthfully and
 *     always emits tools/list_changed.
 */

const ENCRYPTION_KEY = 'JxQK0aw3pPRtKwhsoa3J9wQVcYAvkjbqcCpPjC4Sh7M='
const testEnv = {
  ...(env as unknown as WorkerEnv),
  ENCRYPTION_KEY,
  PUBLIC_BASE_URL: 'https://ctx.test'
} as WorkerEnv

const UPS = 'ups-dead'
const NOW = () => Math.floor(Date.now() / 1000)

const row: UpstreamServerRow = {
  id: UPS,
  slug: 'up-dead',
  display_name: 'Dead',
  transport: 'streamable_http',
  url: 'https://dead.test/mcp',
  auth_strategy: 'user_oauth',
  auth_config: '{}', // DCR path
  enabled: 1,
  created_at: 0,
  updated_at: 0
}

type Handler = (args: unknown, extra?: unknown) => Promise<{ isError?: boolean; content: { text: string }[] }>

function fakeServer() {
  return {
    registerTool: vi.fn(),
    server: { sendToolListChanged: vi.fn() }
  }
}

function handlerFor(server: ReturnType<typeof fakeServer>, name: string): Handler {
  const call = server.registerTool.mock.calls.find((c) => c[0] === name)
  if (!call) throw new Error(`tool ${name} was not registered`)
  return call[2] as Handler
}

/** A makeClient spy whose clients record the bearer they were built with. */
function clientFactory() {
  const bearers: (string | null)[] = []
  const callTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }))
  const make = vi.fn((_conn: unknown, bearer: string | null): UpstreamClient => {
    bearers.push(bearer)
    return { listTools: vi.fn(async () => []), callTool, close: async () => {} }
  })
  return { make, bearers, callTool }
}

function newRegistry(make: ReturnType<typeof clientFactory>['make'], usage: RecordUsageArgs[] = []) {
  return new UpstreamProxyRegistry(
    testEnv,
    'u-1',
    async (a) => {
      usage.push(a)
    },
    'sess-1',
    make as never
  )
}

const provider = () => new UpstreamOAuthProvider(testEnv, row, 'u-1')

async function saveTokens(accessToken: string, expiresIn: number): Promise<void> {
  await provider().saveTokens({
    access_token: accessToken,
    token_type: 'Bearer',
    refresh_token: `RT-${accessToken}`,
    expires_in: expiresIn
  })
}

beforeEach(async () => {
  await testEnv.DB.batch([
    testEnv.DB.prepare('DELETE FROM tool_access'),
    testEnv.DB.prepare('DELETE FROM upstream_tools'),
    testEnv.DB.prepare('DELETE FROM upstream_visibility'),
    testEnv.DB.prepare('DELETE FROM user_credentials'),
    testEnv.DB.prepare('DELETE FROM upstream_servers'),
    testEnv.DB.prepare('DELETE FROM users'),
    testEnv.DB.prepare(
      `INSERT INTO users (id, email, idp, idp_sub, created_at)
       VALUES ('u-1', 'u1@example.test', 'github', 'gh-1', 0)`
    ),
    testEnv.DB.prepare(
      `INSERT INTO upstream_servers
         (id, slug, display_name, transport, url, auth_strategy, auth_config, created_at, updated_at)
       VALUES ('${UPS}', 'up-dead', 'Dead', 'streamable_http', 'https://dead.test/mcp', 'user_oauth', '{}', 0, 0)`
    ),
    testEnv.DB.prepare(
      `INSERT INTO upstream_visibility (upstream_id, scope_kind, scope_id)
       VALUES ('${UPS}', 'everyone', '')`
    ),
    ...['alpha', 'beta'].map((n) =>
      testEnv.DB.prepare(
        `INSERT INTO upstream_tools (upstream_id, tool_name, description, input_schema, cached_at)
         VALUES ('${UPS}', ?1, ?2, '{}', ?3)`
      ).bind(n, `does ${n}`, NOW())
    )
  ])
})

afterEach(async () => {
  vi.restoreAllMocks()
  await testEnv.DB.batch([
    testEnv.DB.prepare('DELETE FROM upstream_tools'),
    testEnv.DB.prepare('DELETE FROM upstream_visibility'),
    testEnv.DB.prepare('DELETE FROM user_credentials'),
    testEnv.DB.prepare('DELETE FROM upstream_servers'),
    testEnv.DB.prepare('DELETE FROM users')
  ])
})

describe('dead upstream credential (real D1)', () => {
  it('keeps the tools listed, without dialling, when the credential is flagged', async () => {
    await saveTokens('stale-AT', 10)
    await markReauthRequired(testEnv, 'u-1', UPS)
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const { make } = clientFactory()
    const server = fakeServer()

    await newRegistry(make).init(server as unknown as McpServer)

    expect(server.registerTool.mock.calls.map((c) => c[0]).sort()).toEqual([
      'up-dead__alpha',
      'up-dead__beta'
    ])
    expect(make).not.toHaveBeenCalled() // no client bound…
    expect(fetchSpy).not.toHaveBeenCalled() // …and the dead refresh token is not re-POSTed
  })

  it('lists nothing for an upstream the user never connected', async () => {
    const { make } = clientFactory()
    const server = fakeServer()
    await newRegistry(make).init(server as unknown as McpServer)
    expect(server.registerTool).not.toHaveBeenCalled()
  })

  it('fails the call loudly, records it, then heals on a plain retry after re-authorization', async () => {
    await saveTokens('stale-AT', 10)
    await markReauthRequired(testEnv, 'u-1', UPS)
    const { make, bearers, callTool } = clientFactory()
    const usage: RecordUsageArgs[] = []
    const server = fakeServer()
    await newRegistry(make, usage).init(server as unknown as McpServer)
    const alpha = handlerFor(server, 'up-dead__alpha')

    const blocked = await alpha({})
    expect(blocked.isError).toBe(true)
    expect(blocked.content[0]?.text).toContain('credential_revoked')
    expect(blocked.content[0]?.text).toContain('https://ctx.test/app/upstreams')
    expect(blocked.content[0]?.text).toContain('just retry this call')
    expect(callTool).not.toHaveBeenCalled()
    expect(usage).toHaveLength(1)
    expect(usage[0]).toMatchObject({ status: 'error', errorCode: 'credential_revoked' })

    // The user re-authorizes in the browser: fresh tokens land, flag clears.
    await saveTokens('fresh-AT', 3600)

    const healed = await alpha({})
    expect(healed.isError).toBeFalsy()
    expect(bearers).toEqual(['fresh-AT']) // bound on demand, onto the NEW token
    expect(callTool).toHaveBeenCalledOnce()
    expect(usage[1]).toMatchObject({ status: 'ok' })
    // The tool list never changed, so nothing had to be re-announced.
    expect(server.registerTool).toHaveBeenCalledTimes(2)
  })

  it('refresh() reports still-unbound, then recovered — never re-registering a listed tool', async () => {
    await saveTokens('stale-AT', 10)
    await markReauthRequired(testEnv, 'u-1', UPS)
    const { make } = clientFactory()
    const server = fakeServer()
    const registry = newRegistry(make)
    await registry.init(server as unknown as McpServer)

    const before = await registry.refresh(server as unknown as McpServer)
    expect(before).toMatchObject({ added: [], recovered: [], unbound: ['up-dead'], loaded: 0 })
    // Always announced — the client's list may be stale after a DO wake even
    // when this instance's diff is empty.
    expect(server.server.sendToolListChanged).toHaveBeenCalledTimes(1)

    await saveTokens('fresh-AT', 3600)

    const after = await registry.refresh(server as unknown as McpServer)
    expect(after).toMatchObject({ added: [], recovered: ['up-dead'], unbound: [], loaded: 1 })
    expect(server.registerTool).toHaveBeenCalledTimes(2) // a duplicate name would throw
  })

  it('rebinds a live session when the stored credential changes under it', async () => {
    await saveTokens('AT-1', 3600)
    const { make, bearers, callTool } = clientFactory()
    const server = fakeServer()
    await newRegistry(make).init(server as unknown as McpServer)
    const alpha = handlerFor(server, 'up-dead__alpha')

    await alpha({})
    expect(bearers).toEqual(['AT-1'])

    // Renewed in the browser / refreshed by another session. `updated_at` is
    // whole seconds, so move it explicitly rather than sleeping.
    await saveTokens('AT-2', 3600)
    await testEnv.DB.prepare(
      `UPDATE user_credentials SET updated_at = updated_at + 5 WHERE user_id = 'u-1' AND upstream_id = ?1`
    )
      .bind(UPS)
      .run()

    await alpha({})
    expect(bearers).toEqual(['AT-1', 'AT-2'])
    await alpha({}) // unchanged since → no third bind
    expect(bearers).toEqual(['AT-1', 'AT-2'])
    expect(callTool).toHaveBeenCalledTimes(3)
  })
})
