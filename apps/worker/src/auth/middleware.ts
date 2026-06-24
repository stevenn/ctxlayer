import type { Context, MiddlewareHandler } from 'hono'
import type { Env } from '../env'
import {
  readSessionCookie,
  sessionClearCookie,
  sessionSetCookie,
  signSession,
  verifySession
} from './session'
import { csrfSetCookie, newCsrfToken } from './csrf'
import { accessTrustConfigured, verifyCfAccessJwt } from './cf-access'
import { findById, upsertUser, type UserRow } from '../db/queries/users'
import type { Role } from '@ctxlayer/shared'

export interface SessionUser {
  userId: string
  role: Role
}

// `userRow` is the full DB row the per-request lifecycle re-check already
// fetched — exposed so handlers that need it (/api/me) don't re-query.
export type AuthedVariables = { user: SessionUser; userRow: UserRow }

type Ctx = Context<{ Bindings: Env; Variables: AuthedVariables }>

/**
 * Resolve the signed-in user for a request: verify the session cookie, then
 * re-check the DB row every request (plan L). The cookie is a 30-day bearer,
 * so without this re-check a suspended or deleted user would keep full access
 * until it expired. A non-active / missing row yields a 401 that ALSO clears
 * the cookie, so the browser drops it and the SPA bounces to /sign-in (where
 * a fresh sign-in surfaces the real `suspended` reason).
 *
 * The role is taken from the DB, not the cookie, so an admin demote/promote
 * also takes effect immediately.
 */
async function resolveActiveUser(
  c: Ctx
): Promise<{ user: SessionUser; row: UserRow } | { error: Response }> {
  // 1. An existing session cookie wins — the cheap path, no Access/IdP work.
  const cookie = readSessionCookie(c.req.raw)
  const payload = await verifySession(cookie, c.env.SESSION_COOKIE_SECRET)
  if (payload) {
    const row = await findById(c.env, payload.userId)
    if (!row || row.status !== 'active') {
      const res = c.json({ error: 'not_signed_in' }, 401)
      res.headers.append('Set-Cookie', sessionClearCookie())
      return { error: res }
    }
    return { user: { userId: row.id, role: row.role }, row }
  }

  // 2. No session yet — when deployed behind Cloudflare Access, mint one from
  //    the edge-asserted identity. Only the first request of a session reaches
  //    here; the cookie set below short-circuits every request after it.
  if (accessTrustConfigured(c.env)) {
    const established = await establishFromAccess(c)
    if (established) return established
  }

  return { error: c.json({ error: 'not_signed_in' }, 401) }
}

/**
 * Establish a session from a Cloudflare Access token (Cf-Access-Jwt-Assertion).
 * On success returns the resolved user AND appends fresh session + CSRF cookies
 * to the response — exactly like the IdP sign-in tail (idp/flow.ts) — so the
 * SPA behaves identically afterwards. Returns an error Response for a
 * known-but-inactive account, or null when there's no usable Access token (the
 * caller then falls through to a 401).
 *
 * Cloudflare Access has already decided WHO may reach the app (its own policy /
 * group rules), so this admits the verified identity directly: it does NOT run
 * the local IdP allowlist/admission. A user suspended IN THE APP is still
 * blocked (stored status wins), and ADMIN_EMAILS still confers admin.
 */
async function establishFromAccess(
  c: Ctx
): Promise<{ user: SessionUser; row: UserRow } | { error: Response } | null> {
  const token = c.req.header('cf-access-jwt-assertion')
  if (!token) return null
  const identity = await verifyCfAccessJwt(token, c.env)
  if (!identity) return null

  const { user } = await upsertUser(
    c.env,
    {
      idp: 'access',
      idpSub: identity.sub,
      email: identity.email,
      name: identity.name,
      avatarUrl: null
    },
    'active'
  )
  if (user.status !== 'active') {
    const res = c.json({ error: 'not_signed_in' }, 401)
    res.headers.append('Set-Cookie', sessionClearCookie())
    return { error: res }
  }

  const session = await signSession(
    { userId: user.id, role: user.role },
    c.env.SESSION_COOKIE_SECRET
  )
  c.header('Set-Cookie', sessionSetCookie(session), { append: true })
  c.header('Set-Cookie', csrfSetCookie(newCsrfToken()), { append: true })
  return { user: { userId: user.id, role: user.role }, row: user }
}

/**
 * Hono middleware that requires a valid, active session. On failure returns
 * 401. On success exposes the user via `c.get('user')`.
 *
 * Example:
 *   const route = new Hono<{ Bindings: Env, Variables: AuthedVariables }>()
 *   route.use('*', requireUser)
 *   route.get('/', (c) => c.json({ userId: c.get('user').userId }))
 */
export const requireUser: MiddlewareHandler<{
  Bindings: Env
  Variables: AuthedVariables
}> = async (c, next) => {
  const resolved = await resolveActiveUser(c)
  if ('error' in resolved) return resolved.error
  c.set('user', resolved.user)
  c.set('userRow', resolved.row)
  await next()
}

/** Same as requireUser, but additionally requires role==='admin'. */
export const requireAdmin: MiddlewareHandler<{
  Bindings: Env
  Variables: AuthedVariables
}> = async (c, next) => {
  const resolved = await resolveActiveUser(c)
  if ('error' in resolved) return resolved.error
  if (resolved.user.role !== 'admin') return c.json({ error: 'forbidden' }, 403)
  c.set('user', resolved.user)
  c.set('userRow', resolved.row)
  await next()
}
