import { env } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Env as WorkerEnv } from '../../src/env'
import { UpstreamProxyRegistry } from '../../src/mcp/proxy-registry'
import type { UpstreamClient } from '../../src/upstream/upstream-client'

/**
 * Pins the once-per-session first-result playbook hint
 * (docs/plan/O-result-skill-hint.md): the FIRST successful proxied result
 * per upstream gains one extra ⟦ctxlayer⟧-marked text item naming the
 * whole-upstream playbooks; later results, error results, and sessions
 * with no whole-upstream attachments stay untouched — and an error does
 * not consume the hint.
 */

const testEnv = env as unknown as WorkerEnv
const UPS = 'ups-hint'
const NOW = () => Math.floor(Date.now() / 1000)

type ToolHandler = (
  args: unknown,
  extra?: unknown
) => Promise<{ isError?: boolean; content: Array<{ type: string; text?: string }> }>

function fakeServer() {
  return {
    registerTool: vi.fn(),
    server: { sendToolListChanged: vi.fn() }
  }
}

function makeRegistry(client: UpstreamClient) {
  return new UpstreamProxyRegistry(testEnv, 'u-1', async () => {}, 'sess-1', () => client)
}

/** The registered handler for the (single) seeded tool. */
function handlerOf(server: ReturnType<typeof fakeServer>): ToolHandler {
  return server.registerTool.mock.calls[0]![2] as ToolHandler
}

const HINT_RE = /^⟦ctxlayer⟧ .*sk-hint-playbook.*⟦\/ctxlayer⟧$/s

beforeEach(async () => {
  await testEnv.DB.batch([
    testEnv.DB.prepare('DELETE FROM skill_attachments'),
    testEnv.DB.prepare('DELETE FROM skills'),
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
       VALUES ('${UPS}', 'up-hint', 'Hint', 'streamable_http', 'https://hint.test/mcp', 'none', '{}', 0, 0)`
    ),
    testEnv.DB.prepare(
      `INSERT INTO upstream_visibility (upstream_id, scope_kind, scope_id)
       VALUES ('${UPS}', 'everyone', '')`
    ),
    testEnv.DB.prepare(
      `INSERT OR REPLACE INTO upstream_tools (upstream_id, tool_name, description, input_schema, cached_at)
       VALUES ('${UPS}', 'alpha', 'does alpha', '{}', ${NOW()})`
    )
  ])
})

afterEach(async () => {
  await testEnv.DB.batch([
    testEnv.DB.prepare('DELETE FROM skill_attachments'),
    testEnv.DB.prepare('DELETE FROM skills'),
    testEnv.DB.prepare('DELETE FROM upstream_tools'),
    testEnv.DB.prepare('DELETE FROM upstream_visibility'),
    testEnv.DB.prepare('DELETE FROM upstream_servers'),
    testEnv.DB.prepare('DELETE FROM users')
  ])
})

async function attachWholeUpstreamSkill(): Promise<void> {
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO skills (id, slug, title, description, status, visibility, created_by, created_at, updated_at)
       VALUES ('sk-1', 'sk-hint-playbook', 'Hint Playbook', 'when hinting', 'published', 'org', 'u-1', 0, 0)`
    ),
    testEnv.DB.prepare(
      `INSERT INTO skill_attachments (skill_id, upstream_id, tool_name, created_at, created_by)
       VALUES ('sk-1', '${UPS}', '', 0, 'u-1')`
    )
  ])
}

describe('first-result playbook hint (real D1)', () => {
  it('appends the marked hint to the first success only, then never again', async () => {
    await attachWholeUpstreamSkill()
    const client: UpstreamClient = {
      listTools: vi.fn(async () => []),
      callTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'hello' }] })),
      close: async () => {}
    }
    const server = fakeServer()
    await makeRegistry(client).init(server as unknown as McpServer)

    const first = await handlerOf(server)({})
    expect(first.content).toHaveLength(2)
    expect(first.content[0]).toEqual({ type: 'text', text: 'hello' })
    expect(first.content[1]!.text).toMatch(HINT_RE)
    expect(first.content[1]!.text).toContain('skill `sk-hint-playbook` ("Hint Playbook")')
    // Author description never rides the hint.
    expect(first.content[1]!.text).not.toContain('when hinting')

    const second = await handlerOf(server)({})
    expect(second.content).toHaveLength(1)
  })

  it('an error result is untouched and does not consume the hint', async () => {
    await attachWholeUpstreamSkill()
    const callTool = vi
      .fn()
      .mockResolvedValueOnce({ isError: true, content: [{ type: 'text', text: 'boom' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'recovered' }] })
    const client: UpstreamClient = {
      listTools: vi.fn(async () => []),
      callTool,
      close: async () => {}
    }
    const server = fakeServer()
    await makeRegistry(client).init(server as unknown as McpServer)

    const errored = await handlerOf(server)({})
    expect(errored.isError).toBe(true)
    expect(errored.content.some((c) => HINT_RE.test(c.text ?? ''))).toBe(false)

    const success = await handlerOf(server)({})
    expect(success.content).toHaveLength(2)
    expect(success.content[1]!.text).toMatch(HINT_RE)
  })

  it('hinted first result drops structuredContent so clients render the content array (Driver-shape)', async () => {
    // Production Driver results return {payload, error_message} as BOTH a
    // text item and structuredContent. Clients render the structured value
    // INSTEAD of the content array when both are present (2026-08-27 field
    // tests: the hint survived every server layer yet never reached the
    // model), so the ONE hinted result omits structuredContent — the text
    // item carries the identical JSON. Later results keep it.
    await attachWholeUpstreamSkill()
    const body = { payload: ['lucy-a', 'yuki-b'], error_message: null }
    const client: UpstreamClient = {
      listTools: vi.fn(async () => []),
      callTool: vi.fn(async () => ({
        content: [{ type: 'text', text: JSON.stringify(body) }],
        structuredContent: body
      })),
      close: async () => {}
    }
    const server = fakeServer()
    await makeRegistry(client).init(server as unknown as McpServer)

    const first = (await handlerOf(server)({})) as {
      content: Array<{ type: string; text?: string }>
      structuredContent?: unknown
    }
    expect(first.content).toHaveLength(2)
    expect(first.content[1]!.text).toMatch(HINT_RE)
    expect(first.content[0]!.text).toBe(JSON.stringify(body))
    expect('structuredContent' in first).toBe(false)

    const second = (await handlerOf(server)({})) as {
      content: Array<{ type: string; text?: string }>
      structuredContent?: unknown
    }
    expect(second.content).toHaveLength(1)
    expect(second.structuredContent).toEqual(body)
  })

  it('no whole-upstream attachment → no hint ever', async () => {
    const client: UpstreamClient = {
      listTools: vi.fn(async () => []),
      callTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'hello' }] })),
      close: async () => {}
    }
    const server = fakeServer()
    await makeRegistry(client).init(server as unknown as McpServer)

    const result = await handlerOf(server)({})
    expect(result.content).toHaveLength(1)
  })
})
