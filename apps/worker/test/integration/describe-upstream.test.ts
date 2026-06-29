import { env } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Env } from '../../src/env'
import { UpstreamProxyRegistry } from '../../src/mcp/tools-proxy'

/**
 * End-to-end (real D1) cover for `describe_upstream`'s catalogue
 * (`UpstreamProxyRegistry.describeUpstreamForUser`). The pure helpers are
 * unit-tested (tools-proxy.test.ts: grouping/summary; tool-acl.test.ts:
 * `visibleTools`); this pins the wiring through real D1 — visibility gate,
 * per-tool ACL hiding, and family grouping over the cached catalogue.
 */

const testEnv = env as unknown as Env

const TOOLS: Array<{ name: string; desc: string | null }> = [
  { name: 'wit_work_item', desc: 'Read operations on Azure DevOps work items. Use action to choose.' },
  { name: 'wit_query', desc: 'Run and list WIQL queries.' },
  { name: 'repo_branch', desc: 'Read repository branches.' },
  { name: 'search', desc: null } // no underscore → ungrouped
]

async function seed(): Promise<void> {
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO users (id, email, idp, idp_sub, created_at)
       VALUES ('u-1', 'u1@example.test', 'github', 'gh-1', 0)`
    ),
    // Visible-to-everyone upstream we describe.
    testEnv.DB.prepare(
      `INSERT INTO upstream_servers
         (id, slug, display_name, transport, url, auth_strategy, auth_config, created_at, updated_at)
       VALUES ('ups-ado', 'up-ado', 'ADO', 'streamable_http', 'https://ado.test/mcp', 'none', '{}', 0, 0)`
    ),
    testEnv.DB.prepare(
      `INSERT INTO upstream_visibility (upstream_id, scope_kind, scope_id)
       VALUES ('ups-ado', 'everyone', '')`
    ),
    // A second upstream visible only to a team u-1 is NOT in.
    testEnv.DB.prepare(
      `INSERT INTO upstream_servers
         (id, slug, display_name, transport, url, auth_strategy, auth_config, created_at, updated_at)
       VALUES ('ups-secret', 'up-secret', 'Secret', 'streamable_http', 'https://secret.test/mcp', 'none', '{}', 0, 0)`
    ),
    testEnv.DB.prepare(
      `INSERT INTO upstream_visibility (upstream_id, scope_kind, scope_id)
       VALUES ('ups-secret', 'team', 't-not-mine')`
    ),
    // Lock wit_query to role r_eng (u-1 has no roles → it must be hidden).
    testEnv.DB.prepare(
      `INSERT INTO tool_access (upstream_id, tool_name, principal_kind, principal_id, created_at)
       VALUES ('ups-ado', 'wit_query', 'role', 'r_eng', 0)`
    )
  ])
  await testEnv.DB.batch(
    TOOLS.map((t) =>
      testEnv.DB.prepare(
        `INSERT INTO upstream_tools (upstream_id, tool_name, description, input_schema, cached_at)
         VALUES ('ups-ado', ?1, ?2, '{}', 0)`
      ).bind(t.name, t.desc)
    )
  )
}

async function cleanup(): Promise<void> {
  await testEnv.DB.batch([
    testEnv.DB.prepare(`DELETE FROM tool_access`),
    testEnv.DB.prepare(`DELETE FROM upstream_tools`),
    testEnv.DB.prepare(`DELETE FROM upstream_visibility`),
    testEnv.DB.prepare(`DELETE FROM upstream_servers`),
    testEnv.DB.prepare(`DELETE FROM users`)
  ])
}

describe('describeUpstreamForUser (real D1)', () => {
  beforeEach(seed)
  afterEach(cleanup)

  it('groups visible tools by family and HIDES the ACL-locked one', async () => {
    const body = await UpstreamProxyRegistry.describeUpstreamForUser(testEnv, 'u-1', 'up-ado')
    expect(body).not.toBeNull()
    if (!body) return

    expect(body).toMatchObject({ slug: 'up-ado', displayName: 'ADO', toolsCount: 3 })
    // families: repo, wit (alpha), '' (ungrouped) last.
    expect(body.groups.map((g) => g.family)).toEqual(['repo', 'wit', ''])

    const wit = body.groups.find((g) => g.family === 'wit')
    // wit_query is locked to r_eng → hidden; only wit_work_item remains.
    expect(wit?.tools.map((t) => t.name)).toEqual(['wit_work_item'])
    expect(wit?.tools[0]?.call).toBe('up-ado__wit_work_item')
    expect(wit?.tools[0]?.summary).toContain('Read operations on Azure DevOps work items')

    // Sanity: the locked tool is nowhere in the catalogue.
    const allNames = body.groups.flatMap((g) => g.tools.map((t) => t.name))
    expect(allNames).not.toContain('wit_query')
    expect(allNames).toEqual(['repo_branch', 'wit_work_item', 'search'])
  })

  it('honours the family filter', async () => {
    const body = await UpstreamProxyRegistry.describeUpstreamForUser(testEnv, 'u-1', 'up-ado', {
      family: 'repo'
    })
    expect(body?.groups.map((g) => g.family)).toEqual(['repo'])
    expect(body?.groups[0]?.tools.map((t) => t.name)).toEqual(['repo_branch'])
  })

  it('returns null for a slug the caller cannot see', async () => {
    expect(await UpstreamProxyRegistry.describeUpstreamForUser(testEnv, 'u-1', 'up-secret')).toBeNull()
  })

  it('returns null for a slug that does not exist', async () => {
    expect(await UpstreamProxyRegistry.describeUpstreamForUser(testEnv, 'u-1', 'nope')).toBeNull()
  })
})
