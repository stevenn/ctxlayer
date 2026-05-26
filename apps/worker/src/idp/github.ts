/**
 * GitHub OAuth2 sign-in. Code flow + PKCE (defense in depth, not strictly
 * required for a confidential client). Endpoints hard-coded.
 *
 * GitHub's /user response only carries a public email; we fetch
 * /user/emails to find the user's primary verified address. Org
 * membership check is in util/allowlist.ts.
 */

import { Hono } from 'hono'
import type { Env } from '../env'
import { signSession, sessionSetCookie } from '../auth/session'
import { csrfSetCookie, newCsrfToken } from '../auth/csrf'
import { completeMcpAuthorization } from './complete-mcp'
import { upsertUser } from '../db/queries/users'
import { AllowlistError, enforceGithubAllowlist } from '../util/allowlist'
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

const AUTHZ = 'https://github.com/login/oauth/authorize'
const TOKEN = 'https://github.com/login/oauth/access_token'

export const githubIdpRoute = new Hono<{ Bindings: Env }>()

githubIdpRoute.get('/start', async (c) => {
  if (!c.env.GITHUB_CLIENT_ID || !c.env.GITHUB_CLIENT_SECRET) {
    return signInErrorRedirect(c.env, 'github_disabled')
  }
  const state = randomToken(24)
  const verifier = pkceVerifier()
  const challenge = await pkceChallenge(verifier)
  const returnTo = c.req.query('return_to') ?? '/app/docs'
  const oauthRequestId = c.req.query('oauth_request_id') ?? undefined

  const url = new URL(AUTHZ)
  url.searchParams.set('client_id', c.env.GITHUB_CLIENT_ID)
  url.searchParams.set('redirect_uri', callbackUrl(c.env, 'github'))
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', 'read:user user:email read:org')
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('allow_signup', 'false')

  const cookie = await serializeStateCookie(
    { state, codeVerifier: verifier, returnTo, oauthRequestId },
    c.env.SESSION_COOKIE_SECRET
  )
  return new Response(null, {
    status: 302,
    headers: { Location: url.toString(), 'Set-Cookie': cookie }
  })
})

githubIdpRoute.get('/callback', async (c) => {
  const code = c.req.query('code')
  const qstate = c.req.query('state')
  const idpError = c.req.query('error')
  if (idpError) return signInErrorRedirect(c.env, 'idp_error')
  if (!code) return signInErrorRedirect(c.env, 'idp_error')

  const stateRow = await readAndVerifyStateCookie(c.req.raw, qstate, c.env.SESSION_COOKIE_SECRET)
  if (!stateRow) return signInErrorRedirect(c.env, 'state_mismatch')

  // 1. Exchange code for access token.
  const tokenRes = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: c.env.GITHUB_CLIENT_ID,
      client_secret: c.env.GITHUB_CLIENT_SECRET,
      redirect_uri: callbackUrl(c.env, 'github'),
      code_verifier: stateRow.codeVerifier
    })
  })
  if (!tokenRes.ok) {
    // Never log the body — it can carry access_token on partial-success
    // shapes, plus full IdP error metadata.
    console.error('github token exchange failed', tokenRes.status)
    return signInErrorRedirect(c.env, 'token_exchange_failed')
  }
  const token = (await tokenRes.json()) as { access_token?: string; error?: string }
  if (!token.access_token) return signInErrorRedirect(c.env, 'token_exchange_failed')

  // 2. Fetch profile + primary verified email.
  const headers = {
    Authorization: `Bearer ${token.access_token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'ctxlayer'
  }
  const [userRes, emailRes] = await Promise.all([
    fetch('https://api.github.com/user', { headers }),
    fetch('https://api.github.com/user/emails', { headers })
  ])
  if (!userRes.ok || !emailRes.ok) {
    console.error('github profile fetch failed', userRes.status, emailRes.status)
    return signInErrorRedirect(c.env, 'profile_fetch_failed')
  }
  const profile = (await userRes.json()) as {
    id: number
    login: string
    name: string | null
    avatar_url: string | null
  }
  const emails = (await emailRes.json()) as Array<{
    email: string
    primary: boolean
    verified: boolean
  }>
  const primary = emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified)
  if (!primary) return signInErrorRedirect(c.env, 'profile_fetch_failed')

  // 3. Allowlist (org membership OR username).
  try {
    await enforceGithubAllowlist({
      accessToken: token.access_token,
      login: profile.login,
      env: c.env
    })
  } catch (err) {
    if (err instanceof AllowlistError) return signInErrorRedirect(c.env, err.reason)
    throw err
  }

  // 4. Upsert.
  const user = await upsertUser(c.env, {
    idp: 'github',
    idpSub: String(profile.id),
    email: primary.email,
    name: profile.name ?? profile.login,
    avatarUrl: profile.avatar_url
  })

  // 5a. MCP OAuth path — complete the grant and redirect to the
  // MCP client's redirect_uri. No SPA cookie is set.
  if (stateRow.oauthRequestId) {
    return completeMcpAuthorization(c.env, stateRow.oauthRequestId, user)
  }

  // 5b. SPA path — issue session + CSRF cookies.
  const session = await signSession(
    { userId: user.id, role: user.role },
    c.env.SESSION_COOKIE_SECRET
  )
  const res = appRedirect(c.env, stateRow.returnTo)
  const out = new Headers(res.headers)
  out.append('Set-Cookie', sessionSetCookie(session))
  out.append('Set-Cookie', csrfSetCookie(newCsrfToken()))
  out.append('Set-Cookie', clearStateCookie())
  return new Response(null, { status: res.status, headers: out })
})
