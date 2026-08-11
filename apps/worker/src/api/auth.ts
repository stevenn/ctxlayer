import { Hono } from 'hono'
import type { Env } from '../env'
import { readSessionCookie, sessionClearCookie, verifySession } from '../auth/session'
import { csrfClearCookie, requireCsrf } from '../auth/csrf'
import { bumpSessionEpoch } from '../db/queries/users'

export const authRoute = new Hono<{ Bindings: Env }>()

authRoute.use('*', requireCsrf)

authRoute.post('/signout', async (c) => {
  // A7: bump the user's session epoch so EVERY outstanding cookie dies
  // server-side, not just the copy this browser is about to drop.
  // Best-effort on purpose — an anonymous / already-expired sign-out
  // still clears the cookies and 204s (this route deliberately has no
  // requireUser; see the csrf-gates allowlist note).
  const payload = await verifySession(readSessionCookie(c.req.raw), c.env.SESSION_COOKIE_SECRET)
  if (payload) await bumpSessionEpoch(c.env, payload.userId)

  const headers = new Headers()
  headers.append('Set-Cookie', sessionClearCookie())
  headers.append('Set-Cookie', csrfClearCookie())
  return new Response(null, { status: 204, headers })
})
