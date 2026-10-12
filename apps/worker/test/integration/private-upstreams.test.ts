import { createExecutionContext, env } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { app } from '../../src/app'
import { signSession } from '../../src/auth/session'
import type { Env } from '../../src/env'
import {
  getUpstreamForAdmin,
  getUpstreamVisibleToUser,
  listUpstreamsForAdmin,
  listUpstreamsVisibleToUser,
  shareUpstreamWithOrg
} from '../../src/db/queries/upstreams'

/**
 * User-private upstreams (migration 0040): an owned upstream is visible to
 * its owner alone — agent paths AND the admin page — and a grant row on it
 * can never widen that. Another user's private upstream must stay
 * indistinguishable from a nonexistent one.
 */

const BASE = 'https://ctxlayer-private-upstreams.test'
const SESSION_SECRET = 'private-upstreams-integration-secret'
const CSRF = 'csrf-private-upstreams'

const testEnv = {
  ...(env as unknown as Record<string, unknown>),
  PUBLIC_BASE_URL: BASE,
  SESSION_COOKIE_SECRET: SESSION_SECRET
} as unknown as Env

const upstream = (id: string, slug: string, owner: string | null) =>
  testEnv.DB.prepare(
    `INSERT INTO upstream_servers
       (id, slug, display_name, transport, url, auth_strategy, auth_config,
        created_at, updated_at, owner_user_id)
     VALUES (?1, ?2, ?2, 'streamable_http', 'https://' || ?2 || '.test/mcp', 'none', '{}', 0, 0, ?3)`
  ).bind(id, slug, owner)

async function seed(): Promise<void> {
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO users (id, email, idp, idp_sub, role, created_at) VALUES
         ('pu-alice', 'alice@pu.test', 'github', 'pu-gh-alice', 'admin', 0),
         ('pu-bob',   'bob@pu.test',   'github', 'pu-gh-bob',   'admin', 0)`
    ),
    upstream('pu-org', 'up-pu-org', null),
    testEnv.DB.prepare(
      `INSERT INTO upstream_visibility (upstream_id, scope_kind, scope_id)
       VALUES ('pu-org', 'everyone', '')`
    ),
    upstream('pu-alice-own', 'up-pu-alice', 'pu-alice'),
    upstream('pu-bob-own', 'up-pu-bob', 'pu-bob'),
    // A grant that should never exist (the API refuses it) — planted to
    // prove the gate ignores grants on an owned upstream.
    testEnv.DB.prepare(
      `INSERT INTO upstream_visibility (upstream_id, scope_kind, scope_id)
       VALUES ('pu-bob-own', 'everyone', '')`
    )
  ])
}

async function cleanup(): Promise<void> {
  await testEnv.DB.batch([
    testEnv.DB.prepare(`DELETE FROM upstream_servers WHERE id LIKE 'pu-%'`),
    testEnv.DB.prepare(`DELETE FROM audit_log WHERE actor_id LIKE 'pu-%'`),
    testEnv.DB.prepare(`DELETE FROM users WHERE id LIKE 'pu-%'`)
  ])
}

const slugs = (rows: { slug: string }[]) => rows.map((r) => r.slug).sort()

describe('private upstreams — visibility gate (real D1)', () => {
  beforeEach(seed)
  afterEach(cleanup)

  it('shows an owned upstream to its owner only, ignoring any grant on it', async () => {
    expect(slugs(await listUpstreamsVisibleToUser(testEnv, 'pu-alice'))).toEqual([
      'up-pu-alice',
      'up-pu-org'
    ])
    expect(slugs(await listUpstreamsVisibleToUser(testEnv, 'pu-bob'))).toEqual([
      'up-pu-bob',
      'up-pu-org'
    ])
    expect(await getUpstreamVisibleToUser(testEnv, 'pu-alice', { id: 'pu-bob-own' })).toBeNull()
    expect(await getUpstreamVisibleToUser(testEnv, 'pu-alice', { slug: 'up-pu-bob' })).toBeNull()
  })

  it('hides another admin’s private upstream on the admin surface too', async () => {
    expect(slugs(await listUpstreamsForAdmin(testEnv, 'pu-alice'))).toEqual([
      'up-pu-alice',
      'up-pu-org'
    ])
    expect(await getUpstreamForAdmin(testEnv, 'pu-bob-own', 'pu-alice')).toBeNull()
    expect((await getUpstreamForAdmin(testEnv, 'pu-alice-own', 'pu-alice'))?.slug).toBe(
      'up-pu-alice'
    )
  })

  it('shares one way, owner only; grants then apply as usual', async () => {
    expect(await shareUpstreamWithOrg(testEnv, 'pu-alice-own', 'pu-bob')).toBe(false)
    expect(await shareUpstreamWithOrg(testEnv, 'pu-alice-own', 'pu-alice')).toBe(true)
    // No grants yet: Alice lost it too — it is an ordinary ungranted upstream now.
    expect(await getUpstreamVisibleToUser(testEnv, 'pu-alice', { id: 'pu-alice-own' })).toBeNull()
    expect((await getUpstreamForAdmin(testEnv, 'pu-alice-own', 'pu-bob'))?.owner_user_id).toBeNull()
    await testEnv.DB.prepare(
      `INSERT INTO upstream_visibility (upstream_id, scope_kind, scope_id)
       VALUES ('pu-alice-own', 'everyone', '')`
    ).run()
    expect(await getUpstreamVisibleToUser(testEnv, 'pu-bob', { id: 'pu-alice-own' })).not.toBeNull()
  })

  it('cascades away with its owner', async () => {
    await testEnv.DB.prepare(`DELETE FROM users WHERE id = 'pu-bob'`).run()
    expect(await getUpstreamForAdmin(testEnv, 'pu-bob-own', 'pu-alice')).toBeNull()
    const left = await testEnv.DB.prepare(
      `SELECT COUNT(*) AS n FROM upstream_visibility WHERE upstream_id = 'pu-bob-own'`
    ).first<{ n: number }>()
    expect(left?.n).toBe(0)
  })
})

describe('private upstreams — admin REST', () => {
  beforeEach(seed)
  afterEach(cleanup)

  async function call(
    as: 'pu-alice' | 'pu-bob',
    method: string,
    path: string,
    body?: unknown
  ): Promise<Response> {
    const cookie = await signSession({ userId: as, role: 'admin', epoch: 0 }, SESSION_SECRET)
    return app.request(
      `${BASE}${path}`,
      {
        method,
        headers: {
          cookie: `__Host-ctx_session=${cookie}; __Host-ctx_csrf=${CSRF}`,
          origin: BASE,
          'x-csrf': CSRF,
          'content-type': 'application/json'
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      },
      testEnv,
      createExecutionContext()
    )
  }

  it('creates a private upstream owned by the caller', async () => {
    const res = await call('pu-alice', 'POST', '/api/admin/upstreams', {
      slug: 'up-pu-new',
      displayName: 'New',
      transport: 'streamable_http',
      url: 'https://pu-new.test/mcp',
      authStrategy: 'user_bearer',
      private: true
    })
    expect(res.status).toBe(201)
    const row = (await res.json()) as { id: string; private: boolean }
    expect(row.private).toBe(true)
    const stored = await getUpstreamForAdmin(testEnv, row.id, 'pu-alice')
    expect(stored?.owner_user_id).toBe('pu-alice')
    await testEnv.DB.prepare(`DELETE FROM upstream_servers WHERE id = ?1`).bind(row.id).run()
  })

  it('404s every per-id route on another admin’s private upstream, and never deletes it', async () => {
    const list = (await (await call('pu-alice', 'GET', '/api/admin/upstreams')).json()) as {
      slug: string
    }[]
    expect(slugs(list)).toEqual(['up-pu-alice', 'up-pu-org'])
    for (const [method, path] of [
      ['GET', '/api/admin/upstreams/pu-bob-own'],
      ['PATCH', '/api/admin/upstreams/pu-bob-own'],
      ['GET', '/api/admin/upstreams/pu-bob-own/tools'],
      ['GET', '/api/admin/upstreams/pu-bob-own/tool-access'],
      ['POST', '/api/admin/upstreams/pu-bob-own/share']
    ] as const) {
      const res = await call('pu-alice', method, path, method === 'PATCH' ? { displayName: 'x' } : undefined)
      expect(res.status, `${method} ${path}`).toBe(404)
    }
    expect((await call('pu-alice', 'DELETE', '/api/admin/upstreams/pu-bob-own')).status).toBe(204)
    expect(await getUpstreamForAdmin(testEnv, 'pu-bob-own', 'pu-bob')).not.toBeNull()
  })

  it('refuses grants, tool rules and attachments on the owner’s own private upstream', async () => {
    const vis = await call('pu-alice', 'PUT', '/api/admin/upstreams/pu-alice-own/visibility', {
      rules: [{ scopeKind: 'everyone', scopeId: null }]
    })
    expect(vis.status).toBe(409)
    const acl = await call('pu-alice', 'PUT', '/api/admin/upstreams/pu-alice-own/tool-access', {
      toolName: 't',
      rules: []
    })
    expect(acl.status).toBe(409)
    const grants = await testEnv.DB.prepare(
      `SELECT COUNT(*) AS n FROM upstream_visibility WHERE upstream_id = 'pu-alice-own'`
    ).first<{ n: number }>()
    expect(grants?.n).toBe(0)
  })

  it('shares via the route, after which grants are accepted', async () => {
    const shared = await call('pu-alice', 'POST', '/api/admin/upstreams/pu-alice-own/share')
    expect(shared.status).toBe(200)
    expect(((await shared.json()) as { private: boolean }).private).toBe(false)
    expect((await call('pu-alice', 'POST', '/api/admin/upstreams/pu-alice-own/share')).status).toBe(
      409
    )
    const vis = await call('pu-bob', 'PUT', '/api/admin/upstreams/pu-alice-own/visibility', {
      rules: [{ scopeKind: 'everyone', scopeId: null }]
    })
    expect(vis.status).toBe(204)
  })
})
