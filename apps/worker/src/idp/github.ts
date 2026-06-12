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
import { admitOrReject } from './admit'
import type { AdmissionIdentity } from '../util/allowlist'
import { exchangeCodeForToken, finishSignIn } from './flow'
import {
  callbackUrl,
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
  const joinCode = c.req.query('join') ?? undefined

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
    { state, codeVerifier: verifier, returnTo, oauthRequestId, joinCode },
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
  const exchanged = await exchangeCodeForToken(
    c.env,
    'github',
    TOKEN,
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: c.env.GITHUB_CLIENT_ID,
      client_secret: c.env.GITHUB_CLIENT_SECRET,
      redirect_uri: callbackUrl(c.env, 'github'),
      code_verifier: stateRow.codeVerifier
    }),
    { accept: 'application/json' }
  )
  if (!exchanged.ok) return exchanged.res
  const token = exchanged.json as { access_token?: string; error?: string }
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

  // 3 + 4. Admission (allowlist / invite / join code / policy) + upsert.
  // A reject / pending / suspended outcome short-circuits here with its own
  // state-clearing redirect — no session, no MCP grant.
  const identity: AdmissionIdentity = {
    idp: 'github',
    login: profile.login,
    email: primary.email,
    accessToken: token.access_token
  }
  const outcome = await admitOrReject(
    c.env,
    identity,
    {
      idp: 'github',
      idpSub: String(profile.id),
      email: primary.email,
      name: profile.name ?? profile.login,
      avatarUrl: profile.avatar_url
    },
    stateRow.joinCode
  )
  if ('response' in outcome) return outcome.response

  // 5. Complete: MCP OAuth grant or SPA session + CSRF cookies.
  return finishSignIn(c.env, stateRow, outcome.user)
})
