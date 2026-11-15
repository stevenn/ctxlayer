import { env } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type { Env as WorkerEnv, McpProps } from '../../src/env'
import { mcpLaneRouter, type LaneHandler } from '../../src/mcp/stateless/handler'
import { HINT_REARM_SECONDS } from '../../src/mcp/stateless/upstream-tools'
import type { UpstreamClient } from '../../src/upstream/upstream-client'
import type { UsageEventMsg } from '../../src/usage/event'

/**
 * The stateless MCP lane, end to end: a real MCP SDK v2 client (negotiating
 * protocol revision 2026-07-28) → the lane router → the agents SDK's
 * stateless handler → our per-request server factory → real D1. Only the
 * upstream transport and the queues are faked.
 *
 * This is the first suite that drives `/mcp` itself: the session lane's
 * Durable Object cannot be constructed under vitest, the stateless lane can.
 */

const BASE = 'https://mcp.stateless.test'
const NOW = () => Math.floor(Date.now() / 1000)

const ALICE: McpProps = { userId: 'u-alice', email: 'alice@example.test', role: 'user' }
const CLIENT_ID = 'https://claude.ai/oauth/mcp-oauth-client-metadata'

const usage: UsageEventMsg[] = []
const jobs: unknown[] = []
const testEnv = {
  ...(env as unknown as Record<string, unknown>),
  PUBLIC_BASE_URL: BASE,
  MCP_PUBLIC_URL: '',
  USAGE_QUEUE: { send: async (m: UsageEventMsg) => void usage.push(m) },
  JOBS_QUEUE: { send: async (m: unknown) => void jobs.push(m) }
} as unknown as WorkerEnv

/** What the OAuth provider hands the `/mcp` handler for an authenticated call. */
function authedCtx(props: McpProps | undefined): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {},
    props,
    auth: {
      token: 't',
      audience: `${BASE}/mcp`,
      expiresAt: NOW() + 3600,
      scope: ['mcp'],
      userId: props?.userId,
      clientId: CLIENT_ID
    }
  } as unknown as ExecutionContext
}

const sessionLane = {
  fetch: vi.fn(async (_request: Request) => new Response('session-lane', { status: 299 }))
}

let upstream: UpstreamClient
function fakeUpstream(callTool: UpstreamClient['callTool']): UpstreamClient {
  return { listTools: vi.fn(async () => []), callTool, close: async () => {} }
}

/** Call the router as the Worker would, with a Host header like real traffic. */
function route(
  request: Request,
  opts: { props?: McpProps | undefined; env?: WorkerEnv } = {}
): Promise<Response> {
  const headers = new Headers(request.headers)
  headers.set('host', new URL(BASE).host)
  const router = mcpLaneRouter(sessionLane as unknown as LaneHandler, {
    makeClient: () => upstream
  })
  return Promise.resolve(
    router.fetch(
      new Request(request, { headers }),
      opts.env ?? testEnv,
      authedCtx('props' in opts ? opts.props : ALICE)
    )
  )
}

/** A connected 2026-07-28 client for `props`. */
async function connect(props: McpProps | undefined = ALICE) {
  const client = new Client(
    { name: 'test-client', version: '1.0.0' },
    { versionNegotiation: { mode: 'auto' } }
  )
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
      fetch: (input, init) => route(new Request(input as RequestInfo, init), { props })
    })
  )
  return client
}

const textOf = (res: unknown) =>
  (res as { content: Array<{ type: string; text: string }> }).content.map((c) => c.text)

const TABLES = [
  'mcp_hint_ledger',
  'tool_access',
  'skill_attachments',
  'skills',
  'user_credentials',
  'upstream_tools',
  'upstream_visibility',
  'upstream_servers',
  'users'
]
const wipe = () => testEnv.DB.batch(TABLES.map((t) => testEnv.DB.prepare(`DELETE FROM ${t}`)))

const upstreamRow = (id: string, slug: string, strategy = 'none') =>
  testEnv.DB.prepare(
    `INSERT INTO upstream_servers
       (id, slug, display_name, transport, url, auth_strategy, auth_config, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'streamable_http', ?4, ?5, '{}', 0, 0)`
  ).bind(id, slug, slug, `https://${slug}.test/mcp`, strategy)

const visibleToEveryone = (id: string) =>
  testEnv.DB.prepare(
    `INSERT INTO upstream_visibility (upstream_id, scope_kind, scope_id) VALUES (?1, 'everyone', '')`
  ).bind(id)

const cachedTool = (id: string, name: string, schema = '{}') =>
  testEnv.DB.prepare(
    `INSERT INTO upstream_tools (upstream_id, tool_name, description, input_schema, cached_at)
     VALUES (?1, ?2, ?3, ?4, ?5)`
  ).bind(id, name, `does ${name}`, schema, NOW())

beforeEach(async () => {
  usage.length = 0
  jobs.length = 0
  sessionLane.fetch.mockClear()
  upstream = fakeUpstream(vi.fn(async () => ({ content: [{ type: 'text', text: 'hello' }] })))
  await wipe()
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO users (id, email, idp, idp_sub, created_at)
       VALUES ('u-alice', 'alice@example.test', 'github', 'gh-a', 0)`
    ),
    // Granted to everyone, no credential needed.
    upstreamRow('ups-open', 'up-open'),
    visibleToEveryone('ups-open'),
    cachedTool(
      'ups-open',
      'alpha',
      '{"type":"object","properties":{"q":{"type":"string"}},"required":["q"]}'
    ),
    cachedTool('ups-open', 'locked'),
    // `locked` is restricted to a role alice does not hold.
    testEnv.DB.prepare(
      `INSERT INTO tool_access (upstream_id, tool_name, principal_kind, principal_id, created_at)
       VALUES ('ups-open', 'locked', 'role', 'role-nobody', 0)`
    ),
    // Exists, has tools, but nobody was granted visibility.
    upstreamRow('ups-secret', 'up-secret'),
    cachedTool('ups-secret', 'classified'),
    // Visible, but needs a per-user credential alice never connected.
    upstreamRow('ups-oauth', 'up-oauth', 'user_oauth'),
    visibleToEveryone('ups-oauth'),
    cachedTool('ups-oauth', 'needs_login')
  ])
})

afterEach(wipe)

describe('lane routing', () => {
  const legacyInitialize = () =>
    new Request(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'old-client', version: '1' }
        }
      })
    })

  it('sends a 2025-era initialize to the session lane, body intact', async () => {
    const res = await route(legacyInitialize())
    expect(res.status).toBe(299)
    expect(sessionLane.fetch).toHaveBeenCalledTimes(1)
    const forwarded = sessionLane.fetch.mock.calls[0]![0]
    expect(((await forwarded.json()) as { method: string }).method).toBe('initialize')
  })

  it('sends session-id GET and DELETE to the session lane', async () => {
    for (const method of ['GET', 'DELETE']) {
      await route(new Request(`${BASE}/mcp`, { method, headers: { 'mcp-session-id': 's1' } }))
    }
    expect(sessionLane.fetch).toHaveBeenCalledTimes(2)
  })

  it('serves a 2026-07-28 client on the stateless lane, never touching the session lane', async () => {
    const client = await connect()
    expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28')
    await client.listTools()
    expect(sessionLane.fetch).not.toHaveBeenCalled()
  })

  it('the kill switch sends everything to the session lane', async () => {
    const off = { ...testEnv, MCP_STATELESS_LANE: 'off' } as WorkerEnv
    const res = await route(
      new Request(`${BASE}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'mcp-protocol-version': '2026-07-28',
          'mcp-method': 'server/discover'
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover' })
      }),
      { env: off }
    )
    expect(res.status).toBe(299)
    expect(sessionLane.fetch).toHaveBeenCalledTimes(1)
  })
})

describe('discover + tools/list', () => {
  it('delivers the server instructions at discover', async () => {
    const client = await connect()
    expect(client.getInstructions()).toContain('ctxlayer')
  })

  it('lists the built-ins in the session lane order, then only the upstream tools alice may call', async () => {
    const client = await connect()
    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names).toEqual([
      'whoami',
      'list_my_context',
      'list_upstreams',
      'describe_upstream',
      'reload_upstreams',
      'get_doc',
      'search_docs',
      'active_users',
      'poll_task',
      'list_tasks',
      'list_skills',
      'get_skill',
      'draft_skill',
      'save_draft_skill',
      // …and nothing from the ungranted upstream, the ACL-locked tool, or
      // the upstream alice never connected a credential for.
      'up-open__alpha'
    ])
  })

  it("advertises an upstream tool's own JSON Schema and sanitised description", async () => {
    const client = await connect()
    const alpha = (await client.listTools()).tools.find((t) => t.name === 'up-open__alpha')
    expect(alpha?.inputSchema).toMatchObject({ required: ['q'], properties: { q: {} } })
    expect(alpha?.description).toBe('[up-open] does alpha')
  })

  it('a suspended account gets an empty surface on its very next request', async () => {
    const client = await connect()
    await testEnv.DB.prepare(`UPDATE users SET status = 'suspended' WHERE id = 'u-alice'`).run()
    expect((await client.listTools().catch(() => ({ tools: [] }))).tools).toEqual([])
  })
})

describe('tools/call', () => {
  it('runs a built-in with the caller’s props and records it under the stateless lane', async () => {
    const client = await connect()
    const res = await client.callTool({ name: 'whoami', arguments: {} })
    expect(JSON.parse(textOf(res)[0]!)).toEqual(ALICE)
    expect(usage).toHaveLength(1)
    expect(usage[0]).toMatchObject({
      tool: 'whoami',
      userId: 'u-alice',
      upstreamId: null,
      status: 'ok',
      lane: 'stateless',
      protocolVersion: '2026-07-28',
      clientName: 'test-client'
    })
    expect(usage[0]!.sessionId).toMatch(/^sl-[0-9a-f]{24}$/)
  })

  it('proxies an upstream tool and records the call', async () => {
    const client = await connect()
    const res = await client.callTool({ name: 'up-open__alpha', arguments: { q: 'x' } })
    expect(textOf(res)).toEqual(['hello'])
    expect(upstream.callTool).toHaveBeenCalledWith('alpha', { q: 'x' })
    expect(usage[0]).toMatchObject({
      tool: 'up-open__alpha',
      upstreamId: 'ups-open',
      status: 'ok',
      lane: 'stateless',
      clientName: 'test-client'
    })
  })

  it('rejects arguments that fail the upstream schema before anything is sent', async () => {
    const client = await connect()
    const res = await client.callTool({ name: 'up-open__alpha', arguments: {} }).catch((e) => e)
    expect(JSON.stringify(res)).toMatch(/required|Invalid/i)
    expect(upstream.callTool).not.toHaveBeenCalled()
  })

  it('an ungranted upstream, an ACL-locked tool and a made-up tool are indistinguishable', async () => {
    const client = await connect()
    const outcomes: string[] = []
    for (const name of [
      'up-secret__classified',
      'up-open__locked',
      'up-oauth__needs_login',
      'up-open__does_not_exist',
      'up-nowhere__anything'
    ]) {
      const res = await client.callTool({ name, arguments: {} }).catch((e) => e)
      // Normalise away the tool name itself; everything else must match.
      outcomes.push(JSON.stringify(res instanceof Error ? res.message : res).replaceAll(name, 'X'))
    }
    expect(new Set(outcomes).size).toBe(1)
    expect(upstream.callTool).not.toHaveBeenCalled()
    expect(usage).toEqual([])
  })

  it('a thrown upstream error reaches the agent as a generic code, never the raw text', async () => {
    upstream = fakeUpstream(
      vi.fn(async () => {
        throw new Error('connect ECONNREFUSED 10.0.0.7:443 Authorization: Bearer sk-live-SECRET')
      })
    )
    const client = await connect()
    const res = await client.callTool({ name: 'up-open__alpha', arguments: { q: 'x' } })
    const text = textOf(res).join('\n')
    expect(res.isError).toBe(true)
    expect(text).toMatch(/ref=/)
    expect(text).not.toContain('sk-live-SECRET')
    expect(text).not.toContain('10.0.0.7')
    expect(usage[0]).toMatchObject({ tool: 'up-open__alpha', status: 'error', lane: 'stateless' })
    expect(JSON.stringify(usage[0])).not.toContain('sk-live-SECRET')
  })
})

describe('first-result playbook hint', () => {
  beforeEach(async () => {
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO skills (id, slug, title, description, status, visibility, created_by, created_at, updated_at)
         VALUES ('sk-1', 'sk-open-playbook', 'Open Playbook', 'when', 'published', 'org', 'u-alice', 0, 0)`
      ),
      testEnv.DB.prepare(
        `INSERT INTO skill_attachments (skill_id, upstream_id, tool_name, created_at, created_by)
         VALUES ('sk-1', 'ups-open', '', 0, 'u-alice')`
      )
    ])
  })

  const call = async () => {
    const client = await connect()
    return textOf(await client.callTool({ name: 'up-open__alpha', arguments: { q: 'x' } }))
  }

  it('rides the first successful result, then not again within the re-arm window', async () => {
    const first = await call()
    expect(first).toHaveLength(2)
    expect(first[1]).toMatch(/^⟦ctxlayer⟧ .*sk-open-playbook.*⟦\/ctxlayer⟧$/s)
    // A brand-new connection (no session to remember): still not repeated.
    expect(await call()).toEqual(['hello'])
  })

  it('is delivered again once the window has passed', async () => {
    await call()
    await testEnv.DB.prepare(`UPDATE mcp_hint_ledger SET hinted_at = hinted_at - ?1`)
      .bind(HINT_REARM_SECONDS + 1)
      .run()
    expect(await call()).toHaveLength(2)
  })

  it('an error result carries no hint and does not use it up', async () => {
    upstream = fakeUpstream(
      vi
        .fn()
        .mockResolvedValueOnce({ isError: true, content: [{ type: 'text', text: 'boom' }] })
        .mockResolvedValue({ content: [{ type: 'text', text: 'hello' }] })
    )
    expect(await call()).toEqual(['boom'])
    expect(await call()).toHaveLength(2)
  })
})

describe('prompts + resources', () => {
  it('offers the draft-skill prompt and the doc + skill resource templates', async () => {
    const client = await connect()
    const prompts = (await client.listPrompts()).prompts.map((p) => p.name)
    expect(prompts).toContain('draft-skill')
    const templates = (await client.listResourceTemplates()).resourceTemplates.map(
      (t) => t.uriTemplate
    )
    expect(templates).toEqual(
      expect.arrayContaining([
        'mcp://ctxlayer/docs/{id}',
        'mcp://ctxlayer/skills/{slug}',
        'skill://{slug}/SKILL.md'
      ])
    )
  })

  it('reads a resource through the template', async () => {
    const client = await connect()
    const res = await client.readResource({ uri: 'mcp://ctxlayer/docs/nope' })
    expect((res.contents[0] as { text: string }).text).toBe('doc not found: nope')
  })
})

describe('reload_upstreams', () => {
  it('reports the current upstreams and says there is nothing to reload', async () => {
    const client = await connect()
    const body = JSON.parse(textOf(await client.callTool({ name: 'reload_upstreams' }))[0]!)
    expect(body.note).toMatch(/Nothing to reload/)
    expect(body.upstreams.map((u: { slug: string }) => u.slug)).toContain('up-open')
  })
})
