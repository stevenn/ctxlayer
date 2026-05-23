/**
 * Google OIDC sign-in. Code flow with PKCE. Endpoints hard-coded; swap
 * to OIDC discovery (https://accounts.google.com/.well-known/openid-configuration)
 * later if we add more OIDC providers.
 *
 * id_token signature is NOT verified locally: we fetched it directly from
 * Google's token endpoint over TLS with our client_secret, so RFC 6749 §10
 * lets us trust the channel. If we ever accept id_tokens from a different
 * source we must add JWKS verification.
 */

import { Hono } from 'hono'
import type { Env } from '../env'
import { signSession, sessionSetCookie } from '../auth/session'
import { upsertUser } from '../db/queries/users'
import { AllowlistError, enforceGoogleAllowlist } from '../util/allowlist'
import { b64urlDecode } from '../auth/session'
import {
  appRedirect,
  callbackUrl,
  clearStateCookie,
  pkceChallenge,
  pkceVerifier,
  randomToken,
  readAndVerifyStateCookie,
  serializeStateCookie,
  signInErrorRedirect
} from './common'

const AUTHZ = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN = 'https://oauth2.googleapis.com/token'

export const googleIdpRoute = new Hono<{ Bindings: Env }>()

googleIdpRoute.get('/start', async (c) => {
  if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) {
    return signInErrorRedirect(c.env, 'google_disabled')
  }
  const state = randomToken(24)
  const verifier = pkceVerifier()
  const challenge = await pkceChallenge(verifier)
  const returnTo = c.req.query('return_to') ?? '/app/docs'

  const url = new URL(AUTHZ)
  url.searchParams.set('client_id', c.env.GOOGLE_CLIENT_ID)
  url.searchParams.set('redirect_uri', callbackUrl(c.env, 'google'))
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', 'openid email profile')
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'select_account')
  if (c.env.ALLOWED_GOOGLE_HD) url.searchParams.set('hd', c.env.ALLOWED_GOOGLE_HD)

  const cookie = await serializeStateCookie(
    { state, codeVerifier: verifier, returnTo },
    c.env.SESSION_COOKIE_SECRET
  )
  return new Response(null, {
    status: 302,
    headers: { Location: url.toString(), 'Set-Cookie': cookie }
  })
})

googleIdpRoute.get('/callback', async (c) => {
  const code = c.req.query('code')
  const qstate = c.req.query('state')
  const idpError = c.req.query('error')
  if (idpError) return signInErrorRedirect(c.env, 'idp_error')
  if (!code) return signInErrorRedirect(c.env, 'idp_error')

  const stateRow = await readAndVerifyStateCookie(c.req.raw, qstate, c.env.SESSION_COOKIE_SECRET)
  if (!stateRow) return signInErrorRedirect(c.env, 'state_mismatch')

  // 1. Exchange code for tokens.
  const tokenRes = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: c.env.GOOGLE_CLIENT_ID,
      client_secret: c.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: callbackUrl(c.env, 'google'),
      code_verifier: stateRow.codeVerifier
    })
  })
  if (!tokenRes.ok) {
    console.error('google token exchange failed', tokenRes.status, await tokenRes.text())
    return signInErrorRedirect(c.env, 'token_exchange_failed')
  }
  const token = (await tokenRes.json()) as { id_token?: string; access_token?: string }
  if (!token.id_token) return signInErrorRedirect(c.env, 'token_exchange_failed')

  // 2. Decode id_token payload (sig skipped — see file header).
  let claims: { sub?: string; email?: string; name?: string; picture?: string; hd?: string }
  try {
    const middle = token.id_token.split('.')[1]
    if (!middle) throw new Error('bad jwt')
    claims = JSON.parse(new TextDecoder().decode(b64urlDecode(middle)))
  } catch {
    return signInErrorRedirect(c.env, 'profile_fetch_failed')
  }
  if (!claims.sub || !claims.email) return signInErrorRedirect(c.env, 'profile_fetch_failed')

  // 3. Allowlist.
  try {
    enforceGoogleAllowlist({ hd: claims.hd, email: claims.email }, c.env)
  } catch (err) {
    if (err instanceof AllowlistError) return signInErrorRedirect(c.env, err.reason)
    throw err
  }

  // 4. Upsert.
  const user = await upsertUser(c.env, {
    idp: 'google',
    idpSub: claims.sub,
    email: claims.email,
    name: claims.name ?? null,
    avatarUrl: claims.picture ?? null
  })

  // 5. Issue session cookie + redirect.
  const session = await signSession(
    { userId: user.id, role: user.role },
    c.env.SESSION_COOKIE_SECRET
  )
  const res = appRedirect(c.env, stateRow.returnTo)
  const headers = new Headers(res.headers)
  headers.append('Set-Cookie', sessionSetCookie(session))
  headers.append('Set-Cookie', clearStateCookie())
  return new Response(null, { status: res.status, headers })
})
