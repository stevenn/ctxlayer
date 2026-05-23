import { Hono } from 'hono'
import type { Env } from '../env'
import { sessionClearCookie } from '../auth/session'

export const authRoute = new Hono<{ Bindings: Env }>()

/**
 * Sign-out. POST + same-origin Origin check as a lightweight CSRF guard
 * (a real CSRF token cookie lands in M2 when the first non-auth unsafe
 * endpoint arrives).
 */
authRoute.post('/signout', (c) => {
  const origin = c.req.header('origin')
  if (!origin || origin !== c.env.PUBLIC_BASE_URL) {
    return c.json({ error: 'bad_origin' }, 403)
  }
  return new Response(null, {
    status: 204,
    headers: { 'Set-Cookie': sessionClearCookie() }
  })
})
