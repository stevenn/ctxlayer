import { env } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Env as WorkerEnv } from '../../src/env'
import { UpstreamProxyRegistry } from '../../src/mcp/proxy-registry'
import type { UpstreamClient } from '../../src/upstream/upstream-client'

/**
 * Pins `refresh()`'s reconcile step (2026-08-11 Datadog incident): a
 * session that registered while the org-global catalogue was degraded
 * must be able to pick up the healed catalogue via reload_upstreams —
 * previously refresh() skipped already-connected upstreams entirely and
 * the session stayed bound to the subset until reconnect.
 */

const testEnv = env as unknown as WorkerEnv
const UPS = 'ups-rec'
const NOW = () => Math.floor(Date.now() / 1000)

function fakeServer() {
  return {
    registerTool: vi.fn(),
    server: { sendToolListChanged: vi.fn() }
  }
}

const fakeClient: UpstreamClient = {
  // Never dialled in this test: the cache is kept fresh so ensureCatalogue
  // serves it without a listTools round trip.
  listTools: vi.fn(async () => []),
  callTool: vi.fn(async () => ({ content: [] })),
  close: async () => {}
}

async function seedTools(names: string[]): Promise<void> {
  await testEnv.DB.batch(
    names.map((n) =>
      testEnv.DB.prepare(
        `INSERT OR REPLACE INTO upstream_tools (upstream_id, tool_name, description, input_schema, cached_at)
         VALUES (?1, ?2, ?3, '{}', ?4)`
      ).bind(UPS, n, `does ${n}`, NOW())
    )
  )
}

beforeEach(async () => {
  await testEnv.DB.batch([
    testEnv.DB.prepare('DELETE FROM tool_access'),
    testEnv.DB.prepare('DELETE FROM upstream_tools'),
    testEnv.DB.prepare('DELETE FROM upstream_visibility'),
    testEnv.DB.prepare('DELETE FROM upstream_servers'),
    testEnv.DB.prepare('DELETE FROM users'),
    testEnv.DB.prepare(
      `INSERT INTO users (id, email, idp, idp_sub, created_at)
       VALUES ('u-1', 'u1@example.test', 'github', 'gh-1', 0)`
    ),
    testEnv.DB.prepare(
      `INSERT INTO upstream_servers
         (id, slug, display_name, transport, url, auth_strategy, auth_config, created_at, updated_at)
       VALUES ('${UPS}', 'up-rec', 'Rec', 'streamable_http', 'https://rec.test/mcp', 'none', '{}', 0, 0)`
    ),
    testEnv.DB.prepare(
      `INSERT INTO upstream_visibility (upstream_id, scope_kind, scope_id)
       VALUES ('${UPS}', 'everyone', '')`
    )
  ])
})

afterEach(async () => {
  await testEnv.DB.batch([
    testEnv.DB.prepare('DELETE FROM upstream_tools'),
    testEnv.DB.prepare('DELETE FROM upstream_visibility'),
    testEnv.DB.prepare('DELETE FROM upstream_servers'),
    testEnv.DB.prepare('DELETE FROM users')
  ])
})

describe('UpstreamProxyRegistry.refresh reconcile (real D1)', () => {
  it('registers tools that appeared in the catalogue after init', async () => {
    await seedTools(['alpha', 'beta', 'gamma'])
    const server = fakeServer()
    const registry = new UpstreamProxyRegistry(
      testEnv,
      'u-1',
      async () => {},
      'sess-1',
      () => fakeClient
    )
    await registry.init(server as unknown as McpServer)
    expect(server.registerTool).toHaveBeenCalledTimes(3)

    // Another session/admin heals the org-global catalogue (3 → 5).
    await seedTools(['delta', 'epsilon'])

    const { added, loaded } = await registry.refresh(server as unknown as McpServer)
    expect(added).toEqual([{ slug: 'up-rec', tools: 2 }])
    expect(loaded).toBe(1)
    expect(server.registerTool).toHaveBeenCalledTimes(5)
    const names = server.registerTool.mock.calls.map((c) => c[0])
    expect(names).toContain('up-rec__delta')
    expect(names).toContain('up-rec__epsilon')
    expect(server.server.sendToolListChanged).toHaveBeenCalled()
  })

  it('is idempotent — a second refresh adds nothing', async () => {
    await seedTools(['alpha', 'beta'])
    const server = fakeServer()
    const registry = new UpstreamProxyRegistry(
      testEnv,
      'u-1',
      async () => {},
      'sess-1',
      () => fakeClient
    )
    await registry.init(server as unknown as McpServer)
    await seedTools(['gamma'])
    await registry.refresh(server as unknown as McpServer)
    const { added } = await registry.refresh(server as unknown as McpServer)
    expect(added).toEqual([])
    expect(server.registerTool).toHaveBeenCalledTimes(3)
  })

  it('never registers an ACL-hidden tool during reconcile', async () => {
    await seedTools(['alpha'])
    const server = fakeServer()
    const registry = new UpstreamProxyRegistry(
      testEnv,
      'u-1',
      async () => {},
      'sess-1',
      () => fakeClient
    )
    await registry.init(server as unknown as McpServer)

    await seedTools(['locked'])
    await testEnv.DB.prepare(
      `INSERT INTO tool_access (upstream_id, tool_name, principal_kind, principal_id, created_at)
       VALUES ('${UPS}', 'locked', 'role', 'r_eng', 0)`
    ).run()

    const { added } = await registry.refresh(server as unknown as McpServer)
    expect(added).toEqual([])
    const names = server.registerTool.mock.calls.map((c) => c[0])
    expect(names).not.toContain('up-rec__locked')
  })
})
