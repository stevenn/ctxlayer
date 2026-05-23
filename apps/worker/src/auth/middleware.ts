import type { MiddlewareHandler } from 'hono'
import type { Env } from '../env'
import { readSessionCookie, verifySession } from './session'
import type { Role } from '@ctxlayer/shared'

export interface SessionUser {
  userId: string
  role: Role
}

export type AuthedVariables = { user: SessionUser }

/**
 * Hono middleware that requires a valid session cookie. On failure
 * returns 401 with a small JSON body. On success exposes the user via
 * `c.get('user')`.
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
  const cookie = readSessionCookie(c.req.raw)
  const payload = await verifySession(cookie, c.env.SESSION_COOKIE_SECRET)
  if (!payload) {
    return c.json({ error: 'not_signed_in' }, 401)
  }
  c.set('user', { userId: payload.userId, role: payload.role })
  await next()
}

/** Same as requireUser, but additionally requires role==='admin'. */
export const requireAdmin: MiddlewareHandler<{
  Bindings: Env
  Variables: AuthedVariables
}> = async (c, next) => {
  const cookie = readSessionCookie(c.req.raw)
  const payload = await verifySession(cookie, c.env.SESSION_COOKIE_SECRET)
  if (!payload) return c.json({ error: 'not_signed_in' }, 401)
  if (payload.role !== 'admin') return c.json({ error: 'forbidden' }, 403)
  c.set('user', { userId: payload.userId, role: payload.role })
  await next()
}
