import type { Context, MiddlewareHandler } from 'hono'
import type { Env } from '../env'
import { readSessionCookie, sessionClearCookie, verifySession } from './session'
import { findById } from '../db/queries/users'
import type { Role } from '@ctxlayer/shared'

export interface SessionUser {
  userId: string
  role: Role
}

export type AuthedVariables = { user: SessionUser }

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
): Promise<{ user: SessionUser } | { error: Response }> {
  const cookie = readSessionCookie(c.req.raw)
  const payload = await verifySession(cookie, c.env.SESSION_COOKIE_SECRET)
  if (!payload) return { error: c.json({ error: 'not_signed_in' }, 401) }

  const row = await findById(c.env, payload.userId)
  if (!row || row.status !== 'active') {
    const res = c.json({ error: 'not_signed_in' }, 401)
    res.headers.append('Set-Cookie', sessionClearCookie())
    return { error: res }
  }
  return { user: { userId: row.id, role: row.role } }
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
  await next()
}
