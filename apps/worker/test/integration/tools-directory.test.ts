import { env } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Env } from '../../src/env'
import { buildToolsDirectory } from '../../src/api/tools-directory'

/**
 * End-to-end (real D1) cover for the tools-directory builder
 * (`buildToolsDirectory` → `GET /api/tools`). Pure grouping/annotation is
 * unit-tested (tools-directory.test.ts); this pins the wiring: visibility,
 * the SHOW-locked-with-badge stance (vs. describe_upstream's hide), raw
 * toolsCount, principal-name resolution, and empty-cache upstreams.
 */

const testEnv = env as unknown as Env

const TOOLS = ['wit_work_item', 'wit_query', 'repo_branch']

async function seed(): Promise<void> {
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO users (id, email, idp, idp_sub, created_at)
       VALUES ('u-1', 'u1@example.test', 'github', 'gh-1', 0)`
    ),
    // A role the user is NOT in — used to lock wit_query.
    testEnv.DB.prepare(
      `INSERT INTO roles (id, slug, display_name, managed_by_idp, created_at, updated_at)
       VALUES ('r-eng', 'eng', 'Engineering', 0, 0, 0)`
    ),
    // Everyone-visible upstream with a populated catalogue.
    testEnv.DB.prepare(
      `INSERT INTO upstream_servers
         (id, slug, display_name, transport, url, auth_strategy, auth_config, created_at, updated_at)
       VALUES ('ups-ado', 'up-ado', 'ADO', 'streamable_http', 'https://ado.test/mcp', 'none', '{}', 0, 0)`
    ),
    testEnv.DB.prepare(
      `INSERT INTO upstream_visibility (upstream_id, scope_kind, scope_id)
       VALUES ('ups-ado', 'everyone', '')`
    ),
    // Everyone-visible upstream with an EMPTY catalogue (must still be listed).
    testEnv.DB.prepare(
      `INSERT INTO upstream_servers
         (id, slug, display_name, transport, url, auth_strategy, auth_config, created_at, updated_at)
       VALUES ('ups-empty', 'up-empty', 'Empty', 'streamable_http', 'https://empty.test/mcp', 'none', '{}', 0, 0)`
    ),
    testEnv.DB.prepare(
      `INSERT INTO upstream_visibility (upstream_id, scope_kind, scope_id)
       VALUES ('ups-empty', 'everyone', '')`
    ),
    // Team-only upstream the user can't see → must be absent.
    testEnv.DB.prepare(
      `INSERT INTO upstream_servers
         (id, slug, display_name, transport, url, auth_strategy, auth_config, created_at, updated_at)
       VALUES ('ups-secret', 'up-secret', 'Secret', 'streamable_http', 'https://secret.test/mcp', 'none', '{}', 0, 0)`
    ),
    testEnv.DB.prepare(
      `INSERT INTO upstream_visibility (upstream_id, scope_kind, scope_id)
       VALUES ('ups-secret', 'team', 't-not-mine')`
    ),
    // Lock wit_query to role r-eng (u-1 has no roles → restricted, shown).
    testEnv.DB.prepare(
      `INSERT INTO tool_access (upstream_id, tool_name, principal_kind, principal_id, created_at)
       VALUES ('ups-ado', 'wit_query', 'role', 'r-eng', 0)`
    )
  ])
  await testEnv.DB.batch(
    TOOLS.map((name) =>
      testEnv.DB.prepare(
        `INSERT INTO upstream_tools (upstream_id, tool_name, description, input_schema, cached_at)
         VALUES ('ups-ado', ?1, 'desc', '{}', 0)`
      ).bind(name)
    )
  )
}

async function cleanup(): Promise<void> {
  await testEnv.DB.batch([
    testEnv.DB.prepare(`DELETE FROM tool_access`),
    testEnv.DB.prepare(`DELETE FROM upstream_tools`),
    testEnv.DB.prepare(`DELETE FROM upstream_visibility`),
    testEnv.DB.prepare(`DELETE FROM upstream_servers`),
    testEnv.DB.prepare(`DELETE FROM user_roles`),
    testEnv.DB.prepare(`DELETE FROM roles`),
    testEnv.DB.prepare(`DELETE FROM users`)
  ])
}

describe('buildToolsDirectory (real D1)', () => {
  beforeEach(seed)
  afterEach(cleanup)

  it('lists built-ins + visible upstreams, SHOWS the locked tool with a requires-name', async () => {
    const dir = await buildToolsDirectory(testEnv, 'u-1')

    expect(dir.builtins).toHaveLength(12)
    // Built-ins carry their input JSON Schema (for the SPA's schema viewer)
    // only when they take arguments — derived from the registered zod shape.
    expect(dir.builtins.find((b) => b.name === 'describe_upstream')?.inputSchema).toBeDefined()
    expect(dir.builtins.find((b) => b.name === 'active_users')?.inputSchema).toBeDefined()
    expect(dir.builtins.find((b) => b.name === 'draft_skill')?.inputSchema).toBeDefined()
    expect(dir.builtins.find((b) => b.name === 'save_draft_skill')?.inputSchema).toBeDefined()
    expect(dir.builtins.find((b) => b.name === 'whoami')?.inputSchema).toBeUndefined()

    const ado = dir.upstreams.find((u) => u.slug === 'up-ado')
    expect(ado).toBeTruthy()
    // id rides through (for the SPA's lazy per-tool detail fetch).
    expect(ado?.id).toBe('ups-ado')
    // raw cached count — locked tool included (the directory shows it).
    expect(ado?.toolsCount).toBe(3)

    const allTools = ado?.groups.flatMap((g) => g.tools) ?? []
    const witQuery = allTools.find((t) => t.name === 'wit_query')
    expect(witQuery?.restricted).toBe(true)
    expect(witQuery?.requires?.roles).toEqual(['Engineering']) // display name, not id
    expect(witQuery?.call).toBe('up-ado__wit_query')

    const witItem = allTools.find((t) => t.name === 'wit_work_item')
    expect(witItem?.restricted).toBe(false)
    expect(witItem?.requires).toBeUndefined()

    // empty-cache upstream is still listed, with no groups.
    const empty = dir.upstreams.find((u) => u.slug === 'up-empty')
    expect(empty).toBeTruthy()
    expect(empty?.groups).toEqual([])

    // team-only upstream the user can't see is absent.
    expect(dir.upstreams.find((u) => u.slug === 'up-secret')).toBeUndefined()
  })
})
