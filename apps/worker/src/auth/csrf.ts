/**
 * CSRF cookie + middleware. The session cookie is `SameSite=Lax`, which
 * blocks third-party top-level form posts but NOT same-site CSRF (a
 * malicious site that gets the SPA to issue a fetch can still ride the
 * session). A separate cookie+header pair is the canonical fix: the
 * cookie is `Secure` and `__Host-`-prefixed but NOT `HttpOnly`, so the
 * SPA can read it in JS and echo it in `X-CSRF` for every unsafe call.
 * An attacker page can't read the cookie cross-origin, so it can't
 * forge the header.
 *
 * The token never travels alone; verification compares the cookie value
 * with the header value byte-for-byte. There's no server-side token
 * registry — this is the standard "double-submit cookie" pattern.
 */

import type { MiddlewareHandler } from 'hono'
import type { Env } from '../env'
import { b64urlEncode, readCookie } from './session'

export const CSRF_COOKIE_NAME = '__Host-ctx_csrf'
const CSRF_MAX_AGE_SECONDS = 30 * 24 * 60 * 60

export function newCsrfToken(): string {
  const buf = new Uint8Array(32)
  crypto.getRandomValues(buf)
  return b64urlEncode(buf)
}

export function csrfSetCookie(token: string): string {
  // No `HttpOnly`: the SPA must read this cookie to populate `X-CSRF`.
  // `__Host-` requires `Secure`, `Path=/`, and no `Domain` — all
  // satisfied here. `SameSite=Lax` matches the session cookie.
  return `${CSRF_COOKIE_NAME}=${token}; Secure; SameSite=Lax; Path=/; Max-Age=${CSRF_MAX_AGE_SECONDS}`
}

export function csrfClearCookie(): string {
  return `${CSRF_COOKIE_NAME}=; Secure; SameSite=Lax; Path=/; Max-Age=0`
}

export function readCsrfCookie(req: Request): string | undefined {
  return readCookie(req, CSRF_COOKIE_NAME)
}

/** Constant-time string equality. Returns false on length mismatch. */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Hono middleware that enforces double-submit CSRF on unsafe methods.
 * Safe methods (GET/HEAD/OPTIONS) pass through untouched. Unsafe
 * methods require both a same-origin `Origin` AND a `X-CSRF` header
 * that matches the `__Host-ctx_csrf` cookie.
 *
 * The Origin check is a backstop — modern browsers send `Origin` on
 * every unsafe fetch, and rejecting cross-origin requests before token
 * comparison closes off XSS-adjacent token theft scenarios.
 */
export const requireCsrf: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (SAFE_METHODS.has(c.req.method)) {
    await next()
    return
  }
  const origin = c.req.header('origin')
  if (!origin || origin !== c.env.PUBLIC_BASE_URL) {
    return c.json({ error: 'bad_origin' }, 403)
  }
  const cookie = readCsrfCookie(c.req.raw)
  const header = c.req.header('x-csrf')
  if (!cookie || !header || !constantTimeEqual(cookie, header)) {
    return c.json({ error: 'bad_csrf' }, 403)
  }
  await next()
}
