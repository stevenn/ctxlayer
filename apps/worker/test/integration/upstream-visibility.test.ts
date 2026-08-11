import { env } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Env } from '../../src/env'
import {
  getUpstreamVisibleToUser,
  listUpstreamsVisibleToUser,
  listUpstreamsVisibleToUserBySlugs
} from '../../src/db/queries/upstreams'

/**
 * Real-D1 cover for the visible-or-nothing helpers — the single home of
 * the "ungranted ≡ nonexistent" invariant (CLAUDE.md security gotcha).
 * Every null case below must stay indistinguishable from every other.
 */

const testEnv = env as unknown as Env

async function seed(): Promise<void> {
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO users (id, email, idp, idp_sub, created_at)
       VALUES ('u-1', 'u1@example.test', 'github', 'gh-1', 0)`
    ),
    testEnv.DB.prepare(
      `INSERT INTO teams (id, slug, display_name, created_at, updated_at)
       VALUES ('t-mine', 'mine', 'Mine', 0, 0)`
    ),
    testEnv.DB.prepare(
      `INSERT INTO team_members (team_id, user_id, created_at) VALUES ('t-mine', 'u-1', 0)`
    ),
    // Granted via 'everyone'.
    testEnv.DB.prepare(
      `INSERT INTO upstream_servers
         (id, slug, display_name, transport, url, auth_strategy, auth_config, created_at, updated_at)
       VALUES ('ups-open', 'up-open', 'Open', 'streamable_http', 'https://open.test/mcp', 'none', '{}', 0, 0)`
    ),
    testEnv.DB.prepare(
      `INSERT INTO upstream_visibility (upstream_id, scope_kind, scope_id)
       VALUES ('ups-open', 'everyone', '')`
    ),
    // Granted via the caller's team.
    testEnv.DB.prepare(
      `INSERT INTO upstream_servers
         (id, slug, display_name, transport, url, auth_strategy, auth_config, created_at, updated_at)
       VALUES ('ups-team', 'up-team', 'Team', 'sse', 'https://team.test/mcp', 'none', '{}', 0, 0)`
    ),
    testEnv.DB.prepare(
      `INSERT INTO upstream_visibility (upstream_id, scope_kind, scope_id)
       VALUES ('ups-team', 'team', 't-mine')`
    ),
    // Exists, but granted to a team the caller is NOT in.
    testEnv.DB.prepare(
      `INSERT INTO upstream_servers
         (id, slug, display_name, transport, url, auth_strategy, auth_config, created_at, updated_at)
       VALUES ('ups-secret', 'up-secret', 'Secret', 'streamable_http', 'https://secret.test/mcp', 'none', '{}', 0, 0)`
    ),
    testEnv.DB.prepare(
      `INSERT INTO upstream_visibility (upstream_id, scope_kind, scope_id)
       VALUES ('ups-secret', 'team', 't-not-mine')`
    ),
    // Granted to everyone but DISABLED.
    testEnv.DB.prepare(
      `INSERT INTO upstream_servers
         (id, slug, display_name, transport, url, auth_strategy, auth_config, enabled, created_at, updated_at)
       VALUES ('ups-off', 'up-off', 'Off', 'streamable_http', 'https://off.test/mcp', 'none', '{}', 0, 0, 0)`
    ),
    testEnv.DB.prepare(
      `INSERT INTO upstream_visibility (upstream_id, scope_kind, scope_id)
       VALUES ('ups-off', 'everyone', '')`
    )
  ])
}

async function cleanup(): Promise<void> {
  await testEnv.DB.batch([
    testEnv.DB.prepare(`DELETE FROM upstream_visibility`),
    testEnv.DB.prepare(`DELETE FROM upstream_servers`),
    testEnv.DB.prepare(`DELETE FROM team_members`),
    testEnv.DB.prepare(`DELETE FROM teams`),
    testEnv.DB.prepare(`DELETE FROM users`)
  ])
}

describe('getUpstreamVisibleToUser (real D1)', () => {
  beforeEach(seed)
  afterEach(cleanup)

  it('resolves a granted upstream by id and by slug', async () => {
    const byId = await getUpstreamVisibleToUser(testEnv, 'u-1', { id: 'ups-open' })
    expect(byId?.slug).toBe('up-open')
    const bySlug = await getUpstreamVisibleToUser(testEnv, 'u-1', { slug: 'up-team' })
    expect(bySlug?.id).toBe('ups-team')
  })

  it('returns null for ungranted, disabled, and nonexistent alike', async () => {
    expect(await getUpstreamVisibleToUser(testEnv, 'u-1', { id: 'ups-secret' })).toBeNull()
    expect(await getUpstreamVisibleToUser(testEnv, 'u-1', { slug: 'up-secret' })).toBeNull()
    expect(await getUpstreamVisibleToUser(testEnv, 'u-1', { id: 'ups-off' })).toBeNull()
    expect(await getUpstreamVisibleToUser(testEnv, 'u-1', { slug: 'nope' })).toBeNull()
  })

  it('matches listUpstreamsVisibleToUser row-for-row', async () => {
    const list = await listUpstreamsVisibleToUser(testEnv, 'u-1')
    expect(list.map((r) => r.slug).sort()).toEqual(['up-open', 'up-team'])
    for (const row of list) {
      expect(await getUpstreamVisibleToUser(testEnv, 'u-1', { id: row.id })).toEqual(row)
    }
  })
})

describe('listUpstreamsVisibleToUserBySlugs (real D1)', () => {
  beforeEach(seed)
  afterEach(cleanup)

  it('returns only the granted subset of the requested slugs', async () => {
    const rows = await listUpstreamsVisibleToUserBySlugs(testEnv, 'u-1', [
      'up-open',
      'up-secret',
      'up-off',
      'nope'
    ])
    expect(rows.map((r) => r.slug)).toEqual(['up-open'])
  })

  it('returns nothing for an empty request', async () => {
    expect(await listUpstreamsVisibleToUserBySlugs(testEnv, 'u-1', [])).toEqual([])
  })
})
