/**
 * Shared helpers for the IdP redirect dance:
 *   - random state + PKCE verifier/challenge generation,
 *   - signed short-lived state cookie carrying `{state, codeVerifier,
 *     returnTo}` between `start` and `callback`,
 *   - error redirects back to /sign-in with a readable `?error=` code.
 */

import type { Env } from '../env'
import { b64urlDecode, b64urlEncode, hmacSign, hmacVerify, readCookie } from '../auth/session'

const STATE_COOKIE_NAME = '__Host-ctx_oauth_state'
const STATE_MAX_AGE_SECONDS = 10 * 60

export interface StatePayload {
  state: string
  codeVerifier: string
  returnTo: string
  iat: number
  exp: number
  // When present, the IdP callback completes an MCP-client OAuth grant
  // instead of setting a SPA session cookie. The id maps to a KV entry
  // produced by `oauth/authorize-page.ts:handleAuthorize`.
  oauthRequestId?: string
  // A join code entered on /sign-in (or via ?join=), carried through the
  // redirect dance so admission can redeem it at the callback. Reaches the
  // IdP NEVER — only ctxlayer's own /start and the signed state cookie.
  joinCode?: string
}

export function randomToken(byteLength = 32): string {
  const buf = new Uint8Array(byteLength)
  crypto.getRandomValues(buf)
  return b64urlEncode(buf)
}

export function pkceVerifier(): string {
  // RFC 7636: 43–128 unreserved chars. 32 random bytes -> ~43 b64url chars.
  return randomToken(32)
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return b64urlEncode(new Uint8Array(digest))
}

export async function serializeStateCookie(
  payload: {
    state: string
    codeVerifier: string
    returnTo: string
    oauthRequestId?: string
    joinCode?: string
  },
  secret: string,
  now: number = Math.floor(Date.now() / 1000)
): Promise<string> {
  const full: StatePayload = { ...payload, iat: now, exp: now + STATE_MAX_AGE_SECONDS }
  const body = b64urlEncode(new TextEncoder().encode(JSON.stringify(full)))
  const sig = await hmacSign(body, secret)
  return `${STATE_COOKIE_NAME}=${body}.${sig}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${STATE_MAX_AGE_SECONDS}`
}

export function clearStateCookie(): string {
  return `${STATE_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`
}

export async function readAndVerifyStateCookie(
  req: Request,
  queryState: string | undefined,
  secret: string,
  now: number = Math.floor(Date.now() / 1000)
): Promise<StatePayload | null> {
  if (!queryState) return null
  const cookie = readCookie(req, STATE_COOKIE_NAME)
  if (!cookie) return null
  const dot = cookie.indexOf('.')
  if (dot <= 0) return null
  const body = cookie.slice(0, dot)
  const sig = cookie.slice(dot + 1)
  if (!(await hmacVerify(body, sig, secret))) return null
  let payload: StatePayload
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)))
  } catch {
    return null
  }
  if (payload.exp < now) return null
  // Constant-time-ish state comparison.
  if (payload.state.length !== queryState.length) return null
  let mismatch = 0
  for (let i = 0; i < payload.state.length; i++) {
    mismatch |= payload.state.charCodeAt(i) ^ queryState.charCodeAt(i)
  }
  if (mismatch !== 0) return null
  return payload
}

export type ErrorReason =
  | 'google_disabled'
  | 'github_disabled'
  | 'wrong_domain'
  | 'not_in_org'
  | 'state_mismatch'
  | 'token_exchange_failed'
  | 'profile_fetch_failed'
  | 'idp_error'
  // Admission outcomes (plan L). `pending_approval` is a state, not an
  // error — the sign-in page renders it as a friendly waiting message.
  | 'pending_approval'
  | 'invite_required'
  | 'invalid_join_code'
  | 'code_expired'
  | 'access_denied'
  | 'suspended'

export function signInErrorRedirect(env: Env, reason: ErrorReason): Response {
  const url = new URL('/sign-in', env.PUBLIC_BASE_URL)
  url.searchParams.set('error', reason)
  return Response.redirect(url.toString(), 302)
}

export function appRedirect(env: Env, returnTo: string): Response {
  // Only allow same-origin relative paths to avoid open redirects.
  const target = returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/app/docs'
  const url = new URL(target, env.PUBLIC_BASE_URL)
  return Response.redirect(url.toString(), 302)
}

export function callbackUrl(env: Env, idp: 'google' | 'github'): string {
  return new URL(`/idp/${idp}/callback`, env.PUBLIC_BASE_URL).toString()
}
