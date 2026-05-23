import { Hono } from 'hono'
import type { Env } from '../env'
import { sessionClearCookie } from '../auth/session'
import { csrfClearCookie, requireCsrf } from '../auth/csrf'

export const authRoute = new Hono<{ Bindings: Env }>()

authRoute.use('*', requireCsrf)

authRoute.post('/signout', () => {
  const headers = new Headers()
  headers.append('Set-Cookie', sessionClearCookie())
  headers.append('Set-Cookie', csrfClearCookie())
  return new Response(null, { status: 204, headers })
})
