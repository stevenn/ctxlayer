import { env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { app } from '../../src/app'
import { signSession } from '../../src/auth/session'
import type { Env as WorkerEnv } from '../../src/env'

/**
 * Table-driven gate test for the mutation surface (CLAUDE.md: "requireCsrf
 * is per-mutation, not router-wide on admin routes" — this turns that
 * re-check into CI). For every (method, path) below, the real composed Hono
 * app must:
 *
 *   1. reject a request with NO session at all          → 401 not_signed_in
 *   2. reject a valid session + Origin but NO X-CSRF    → 403 bad_csrf
 *   3. reject a valid session with a cross-site Origin  → 403 bad_origin
 *
 * The CSRF/auth middlewares run before any handler or body parsing, so the
 * target ids don't need to exist — no per-route fixtures required. Adding a
 * new mutating route = one line in CASES.
 *
 * Each case is also checked against `app.routes` so a typo'd path (which
 * router-wide `.use('*')` middleware would still 401/403, silently passing
 * assertions 1–3 for a phantom route) fails loudly.
 *
 * Known exclusion: POST /api/auth/signout carries requireCsrf but no
 * requireUser (signing out doesn't need a live session), so the 401
 * assertion can't apply; it's left out rather than special-cased.
 */

const SESSION_SECRET = 'csrf-gates-integration-secret'
const BASE = 'https://ctxlayer-csrf-gates.test'
const SESSION_COOKIE = '__Host-ctx_session'

const testEnv = {
  ...(env as unknown as Record<string, unknown>),
  PUBLIC_BASE_URL: BASE,
  SESSION_COOKIE_SECRET: SESSION_SECRET
} as unknown as WorkerEnv

type Method = 'POST' | 'PUT' | 'PATCH' | 'DELETE'

interface GateCase {
  method: Method
  path: string
}

// One line per mutating route. Paths use literal placeholder ids — the
// gates fire before any lookup, so nothing needs to be seeded for them.
const CASES: GateCase[] = [
  // --- admin: users (per-route requireCsrf — the CLAUDE.md warning case)
  { method: 'PATCH', path: '/api/admin/users/u1' },
  { method: 'PUT', path: '/api/admin/users/u1/roles' },
  { method: 'DELETE', path: '/api/admin/users/u1/credentials' },
  { method: 'POST', path: '/api/admin/users/u1/suspend' },
  { method: 'POST', path: '/api/admin/users/u1/reactivate' },
  { method: 'POST', path: '/api/admin/users/u1/reject' },
  { method: 'DELETE', path: '/api/admin/users/u1' },
  // --- admin: teams
  { method: 'POST', path: '/api/admin/teams' },
  { method: 'PATCH', path: '/api/admin/teams/t1' },
  { method: 'DELETE', path: '/api/admin/teams/t1' },
  { method: 'POST', path: '/api/admin/teams/t1/members' },
  { method: 'DELETE', path: '/api/admin/teams/t1/members/u1' },
  // --- admin: products + team-products
  { method: 'POST', path: '/api/admin/products' },
  { method: 'PATCH', path: '/api/admin/products/p1' },
  { method: 'DELETE', path: '/api/admin/products/p1' },
  { method: 'PUT', path: '/api/admin/team-products' },
  // --- admin: roles
  { method: 'POST', path: '/api/admin/roles' },
  { method: 'PATCH', path: '/api/admin/roles/r1' },
  { method: 'DELETE', path: '/api/admin/roles/r1' },
  // --- admin: upstreams
  { method: 'POST', path: '/api/admin/upstreams' },
  { method: 'PATCH', path: '/api/admin/upstreams/up1' },
  { method: 'DELETE', path: '/api/admin/upstreams/up1' },
  { method: 'PUT', path: '/api/admin/upstreams/up1/visibility' },
  { method: 'PUT', path: '/api/admin/upstreams/up1/tool-access' },
  { method: 'POST', path: '/api/admin/upstreams/up1/refresh-tools' },
  { method: 'PUT', path: '/api/admin/upstreams/up1/shared-credentials' },
  { method: 'DELETE', path: '/api/admin/upstreams/up1/shared-credentials' },
  // --- admin: git-sources
  { method: 'POST', path: '/api/admin/git-sources' },
  { method: 'PATCH', path: '/api/admin/git-sources/g1' },
  { method: 'DELETE', path: '/api/admin/git-sources/g1' },
  { method: 'PUT', path: '/api/admin/git-sources/g1/visibility' },
  { method: 'PUT', path: '/api/admin/git-sources/g1/shared-credentials' },
  { method: 'DELETE', path: '/api/admin/git-sources/g1/shared-credentials' },
  { method: 'PUT', path: '/api/admin/git-sources/g1/oauth' },
  { method: 'DELETE', path: '/api/admin/git-sources/g1/oauth' },
  { method: 'POST', path: '/api/admin/git-sources/g1/sync' },
  // --- admin: invites + join-codes
  { method: 'POST', path: '/api/admin/invites' },
  { method: 'DELETE', path: '/api/admin/invites/i1' },
  { method: 'POST', path: '/api/admin/join-codes' },
  { method: 'DELETE', path: '/api/admin/join-codes/j1' },
  // --- admin: docs reindex + oauth-clients prune (per-route requireCsrf)
  { method: 'POST', path: '/api/admin/docs/reindex' },
  { method: 'POST', path: '/api/admin/oauth-clients/prune' },
  // --- non-admin mutating surface (requireUser + requireCsrf)
  { method: 'POST', path: '/api/docs' },
  { method: 'PATCH', path: '/api/docs/d1' },
  { method: 'DELETE', path: '/api/docs/d1' },
  { method: 'PUT', path: '/api/docs/d1/content' },
  { method: 'POST', path: '/api/docs/d1/restore' },
  { method: 'PUT', path: '/api/docs/d1/lock' },
  { method: 'PUT', path: '/api/docs/d1/tags' },
  { method: 'POST', path: '/api/docs/d1/editors' },
  { method: 'POST', path: '/api/docs/d1/git/pull-request' },
  { method: 'POST', path: '/api/docs/d1/git/review-url' },
  { method: 'PUT', path: '/api/git-sources/g1/credentials' },
  { method: 'DELETE', path: '/api/git-sources/g1/credentials' },
  { method: 'PUT', path: '/api/upstreams/up1/credentials' },
  { method: 'DELETE', path: '/api/upstreams/up1/credentials' },
  { method: 'POST', path: '/api/search' },
  { method: 'PATCH', path: '/api/folders' },
  { method: 'POST', path: '/api/skills' },
  { method: 'PATCH', path: '/api/skills/s1' },
  { method: 'DELETE', path: '/api/skills/s1' },
  { method: 'PUT', path: '/api/skills/s1/content' },
  { method: 'POST', path: '/api/skill-attachments' },
  { method: 'DELETE', path: '/api/skill-attachments' },
  { method: 'POST', path: '/api/doc-attachments' },
  { method: 'DELETE', path: '/api/doc-attachments' }
]

// Admin routers gate on requireAdmin BEFORE requireCsrf, so the
// session-carrying probe must be an admin or a 403 `forbidden` would
// mask the CSRF result we're asserting on.
function roleFor(path: string): 'admin' | 'user' {
  return path.startsWith('/api/admin/') ? 'admin' : 'user'
}

async function seedUser(id: string, role: 'admin' | 'user') {
  await testEnv.DB.prepare(
    `INSERT OR IGNORE INTO users (id, email, name, idp, idp_sub, role, status, created_at)
     VALUES (?1, ?2, NULL, 'github', ?1, ?3, 'active', 1780000000)`
  )
    .bind(id, `${id}@example.com`, role)
    .run()
}

const cookies = new Map<'admin' | 'user', string>()

beforeAll(async () => {
  await seedUser('csrf-gates-admin', 'admin')
  await seedUser('csrf-gates-user', 'user')
  cookies.set(
    'admin',
    `${SESSION_COOKIE}=${await signSession({ userId: 'csrf-gates-admin', role: 'admin' }, SESSION_SECRET)}`
  )
  cookies.set(
    'user',
    `${SESSION_COOKIE}=${await signSession({ userId: 'csrf-gates-user', role: 'user' }, SESSION_SECRET)}`
  )
})

function send(method: Method, path: string, headers: Record<string, string>) {
  return app.request(`${BASE}${path}`, { method, headers }, testEnv)
}

/** Does a registered Hono route pattern (may contain :params) match this concrete path? */
function patternMatches(pattern: string, path: string): boolean {
  const p = pattern.split('/')
  const s = path.split('/')
  if (p.length !== s.length) return false
  return p.every((seg, i) => seg.startsWith(':') || seg === s[i])
}

describe('mutation-surface auth + CSRF gates', () => {
  it.each(CASES)('$method $path is a real route', ({ method, path }) => {
    // Router-wide `.use('*', ...)` middleware would 401/403 even on a
    // path that matches no handler, so the gate assertions alone can't
    // tell a typo'd table entry from a real route. app.routes can.
    const found = app.routes.some(
      (r) => r.method === method && !r.path.endsWith('*') && patternMatches(r.path, path)
    )
    expect(found, `no ${method} route matching ${path} is mounted`).toBe(true)
  })

  it.each(CASES)('$method $path → 401 with no session', async ({ method, path }) => {
    const res = await send(method, path, { origin: BASE })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'not_signed_in' })
  })

  it.each(CASES)('$method $path → 403 bad_csrf without X-CSRF', async ({ method, path }) => {
    const res = await send(method, path, {
      cookie: cookies.get(roleFor(path))!,
      origin: BASE
    })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'bad_csrf' })
  })

  it.each(CASES)('$method $path → 403 bad_origin cross-site', async ({ method, path }) => {
    const res = await send(method, path, {
      cookie: cookies.get(roleFor(path))!,
      origin: 'https://evil.example'
    })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'bad_origin' })
  })
})
