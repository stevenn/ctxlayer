import { env } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Env as WorkerEnv } from '../../src/env'
import { UpstreamProxyRegistry } from '../../src/mcp/proxy-registry'
import { inMemoryHintLedger } from '../../src/mcp/hint-ledger'
import type { UpstreamClient } from '../../src/upstream/upstream-client'

/**
 * Pins the session-start catalogue budget (2026-10-06: 22 DO resets in a day
 * while the ADO MCP hung). `init()` runs inside `blockConcurrencyWhile`, so a
 * stale-catalogue `tools/list` that never answers must not hold registration
 * hostage — the cached catalogue is served once the budget runs out.
 */

const testEnv = env as unknown as WorkerEnv
const UPS = 'ups-budget'
const BUDGET_MS = 50

function fakeServer() {
  return {
    registerTool: vi.fn(),
    server: { sendToolListChanged: vi.fn() }
  }
}

function clientWith(listTools: UpstreamClient['listTools']): UpstreamClient {
  return { listTools, callTool: vi.fn(async () => ({ content: [] })), close: async () => {} }
}

function registry(client: UpstreamClient): UpstreamProxyRegistry {
  return new UpstreamProxyRegistry(
    testEnv,
    'u-1',
    async () => {},
    'sess-1',
    () => client,
    inMemoryHintLedger(),
    BUDGET_MS
  )
}

async function seedStaleTools(names: string[]): Promise<void> {
  // cached_at 0 → far past CATALOGUE_TTL_SECONDS, so init must try a refresh.
  await testEnv.DB.batch(
    names.map((n) =>
      testEnv.DB.prepare(
        `INSERT OR REPLACE INTO upstream_tools (upstream_id, tool_name, description, input_schema, cached_at)
         VALUES (?1, ?2, ?3, '{}', 0)`
      ).bind(UPS, n, `does ${n}`)
    )
  )
}

const registeredNames = (server: ReturnType<typeof fakeServer>) =>
  server.registerTool.mock.calls.map((c) => c[0])

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
       VALUES ('${UPS}', 'up-budget', 'Budget', 'streamable_http', 'https://budget.test/mcp', 'none', '{}', 0, 0)`
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

describe('UpstreamProxyRegistry stale-catalogue budget (real D1)', () => {
  it('serves the cached catalogue when tools/list hangs past the budget', async () => {
    await seedStaleTools(['alpha', 'beta'])
    const hung = clientWith(vi.fn(() => new Promise<never>(() => {})))
    const server = fakeServer()

    const started = Date.now()
    await registry(hung).init(server as unknown as McpServer)

    expect(Date.now() - started).toBeLessThan(5_000)
    expect(hung.listTools).toHaveBeenCalledTimes(1)
    expect(registeredNames(server)).toEqual(['up-budget__alpha', 'up-budget__beta'])
  })

  it('uses a refresh that lands inside the budget', async () => {
    await seedStaleTools(['alpha'])
    const quick = clientWith(
      vi.fn(async () => [
        { toolName: 'alpha', description: 'does alpha', inputSchema: {} },
        { toolName: 'gamma', description: 'does gamma', inputSchema: {} }
      ])
    )
    const server = fakeServer()

    await registry(quick).init(server as unknown as McpServer)

    expect(registeredNames(server)).toEqual(['up-budget__alpha', 'up-budget__gamma'])
  })

  it('lets a refresh that overran the budget still heal the cache for the next session', async () => {
    await seedStaleTools(['alpha'])
    let finish: (tools: Awaited<ReturnType<UpstreamClient['listTools']>>) => void = () => {}
    const slow = clientWith(
      vi.fn(
        () =>
          new Promise<Awaited<ReturnType<UpstreamClient['listTools']>>>((resolve) => {
            finish = resolve
          })
      )
    )
    const first = fakeServer()
    await registry(slow).init(first as unknown as McpServer)
    expect(registeredNames(first)).toEqual(['up-budget__alpha'])

    finish([
      { toolName: 'alpha', description: 'does alpha', inputSchema: {} },
      { toolName: 'delta', description: 'does delta', inputSchema: {} }
    ])
    await vi.waitFor(async () => {
      const rows = await testEnv.DB.prepare(
        'SELECT tool_name FROM upstream_tools WHERE upstream_id = ?1 ORDER BY tool_name'
      )
        .bind(UPS)
        .all<{ tool_name: string }>()
      expect(rows.results.map((r) => r.tool_name)).toEqual(['alpha', 'delta'])
    })
  })
})
