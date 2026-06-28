/**
 * Static (pre-registered) OAuth flow for `user_oauth` upstreams whose IdP
 * does NOT support RFC 7591 dynamic client registration — chiefly Microsoft
 * Entra ID, which fronts the Azure DevOps MCP. Instead of the MCP SDK's
 * `auth()` orchestrator (discovery + DCR), we drive a plain authorization-
 * code + PKCE + refresh flow against admin-supplied `authorizeUrl` /
 * `tokenUrl`, reusing the provider purely for STORAGE (PKCE verifier in KV,
 * sealed tokens in `user_credentials`).
 *
 * Selected by `isStaticOAuthConfig(authConfig)` (shared). The DCR path is
 * unchanged for every other `user_oauth` upstream.
 *
 * Security: token-endpoint responses are NEVER logged with bodies (they
 * carry access/refresh tokens) — status + error code only.
 */

import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import type { UpstreamAuthConfig } from '@ctxlayer/shared'
import type { Env } from '../env'
import { open as openSecret, sealedFromString } from '../crypto/aead'
import { assertSafeFetchUrl } from '../util/safe-fetch'

export type StaticOAuth = NonNullable<UpstreamAuthConfig['oauth']>

/**
 * Thrown on a non-2xx token-endpoint response. `permanent` is true ONLY for an
 * `invalid_grant` rejection (RFC 6749 §5.2): the authorization-code or, more
 * commonly, the refresh token is dead, and only an interactive reconnect
 * recovers it. Everything else — 5xx, 429, network failures, other 4xx codes —
 * is transient (`permanent: false`) so callers keep retrying instead of forcing
 * a needless reconnect / locking the user out.
 */
export class OAuthStaticError extends Error {
  readonly permanent: boolean
  constructor(
    readonly phase: 'exchange' | 'refresh',
    readonly status: number,
    readonly code: string | null
  ) {
    super(`oauth_static_${phase}_failed`)
    this.name = 'OAuthStaticError'
    this.permanent = (status === 400 || status === 401) && code === 'invalid_grant'
  }
}

/**
 * Narrow an auth_config to its static-OAuth sub-config, or null when the
 * upstream is in DCR mode. Lets callers branch without a non-null assertion.
 */
export function staticOAuth(cfg: UpstreamAuthConfig | undefined | null): StaticOAuth | null {
  const o = cfg?.oauth
  return o?.clientId && o?.authorizeUrl && o?.tokenUrl ? (o as StaticOAuth) : null
}

// Reuse a fresh access token rather than refresh on every resolution; mirrors
// the DCR path's buffer in bearer.ts. Entra access tokens live ~90 min.
const REFRESH_BUFFER_S = 5 * 60

/**
 * The subset of `UpstreamOAuthProvider` the static flow touches. Declared
 * structurally so unit tests can pass a lightweight fake without KV / D1.
 */
export interface StaticFlowProvider {
  state(): string
  readonly redirectUrl: string
  saveCodeVerifier(verifier: string): Promise<void>
  codeVerifier(): Promise<string>
  tokens(): Promise<OAuthTokens | undefined>
  saveTokens(tokens: OAuthTokens): Promise<void>
}

/**
 * Build the authorization redirect URL and persist the PKCE verifier (keyed
 * by the provider's state token). The caller 302s to the returned URL.
 */
export async function buildAuthorizeRedirect(
  provider: StaticFlowProvider,
  oauth: StaticOAuth
): Promise<string> {
  const verifier = randomVerifier()
  await provider.saveCodeVerifier(verifier)
  const challenge = await s256Challenge(verifier)
  const url = new URL(requireField(oauth.authorizeUrl, 'authorizeUrl'))
  url.searchParams.set('client_id', requireField(oauth.clientId, 'clientId'))
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', provider.redirectUrl)
  url.searchParams.set('state', provider.state())
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  const scope = scopeString(oauth)
  if (scope) url.searchParams.set('scope', scope)
  return url.toString()
}

/**
 * Exchange an authorization code for tokens and seal them via
 * `provider.saveTokens`. Throws on a non-2xx token response.
 */
export async function exchangeCode(
  env: Env,
  provider: StaticFlowProvider,
  oauth: StaticOAuth,
  code: string
): Promise<void> {
  const verifier = await provider.codeVerifier()
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: provider.redirectUrl,
    client_id: requireField(oauth.clientId, 'clientId'),
    code_verifier: verifier
  })
  const scope = scopeString(oauth)
  if (scope) body.set('scope', scope)
  const json = await postToken(env, oauth, body, 'exchange')
  await provider.saveTokens(toOAuthTokens(json))
}

export interface StaticRefresh {
  /** Usable access token, or null when none could be produced. */
  token: string | null
  /**
   * True ONLY on a permanent refresh rejection (`invalid_grant`) — the caller
   * should flag the credential for interactive reconnect. Transient failures
   * (5xx / 429 / network / other 4xx codes) leave this false so retries
   * continue rather than locking the user out.
   */
  reauth: boolean
}

/**
 * Refresh a static-OAuth access token, returning both the token and whether the
 * failure (if any) was a permanent `invalid_grant` that warrants reconnect.
 * Refreshes via the refresh_token grant only when the stored access token is
 * near expiry; a still-fresh token is returned as-is (no refresh-token rotation).
 */
export async function refreshStaticDetailed(
  env: Env,
  provider: StaticFlowProvider,
  oauth: StaticOAuth
): Promise<StaticRefresh> {
  const current = await provider.tokens()
  if (!current?.access_token && !current?.refresh_token) return { token: null, reauth: false }
  // Still-fresh access token: use as-is, don't rotate the refresh token.
  if (
    current?.access_token &&
    current.expires_in !== undefined &&
    current.expires_in > REFRESH_BUFFER_S
  ) {
    return { token: current.access_token, reauth: false }
  }
  if (!current?.refresh_token) {
    // Near/at expiry with no way to refresh — fall back to whatever access
    // token we have (may still work briefly). Not a reauth signal: we never
    // attempted (and failed) a grant.
    return { token: current?.access_token ?? null, reauth: false }
  }
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: current.refresh_token,
    client_id: requireField(oauth.clientId, 'clientId')
  })
  const scope = scopeString(oauth)
  if (scope) body.set('scope', scope)
  let json: TokenResponse
  try {
    json = await postToken(env, oauth, body, 'refresh')
  } catch (err) {
    // Permanent (invalid_grant) ⇒ signal reauth; any other failure is transient.
    return { token: null, reauth: err instanceof OAuthStaticError && err.permanent }
  }
  await provider.saveTokens(toOAuthTokens(json))
  return { token: typeof json.access_token === 'string' ? json.access_token : null, reauth: false }
}

/**
 * Token-only refresh for callers that don't manage the reauth flag (git creds,
 * the OAuth connect/status endpoints). Returns null when there's nothing usable
 * — the caller then forces an interactive re-auth.
 */
export async function refreshStatic(
  env: Env,
  provider: StaticFlowProvider,
  oauth: StaticOAuth
): Promise<string | null> {
  return (await refreshStaticDetailed(env, provider, oauth)).token
}

// ----- internals ------------------------------------------------------

interface TokenResponse {
  access_token?: string
  token_type?: string
  expires_in?: number
  refresh_token?: string
  scope?: string
}

async function postToken(
  env: Env,
  oauth: StaticOAuth,
  body: URLSearchParams,
  phase: 'exchange' | 'refresh'
): Promise<TokenResponse> {
  const secret = await openClientSecret(env, oauth)
  if (secret) body.set('client_secret', secret)
  const tokenUrl = requireField(oauth.tokenUrl, 'tokenUrl')
  // Dial-site re-check: the code + client_secret + refresh token travel in
  // this POST — never let them go out over cleartext http.
  assertSafeFetchUrl(tokenUrl, 'oauth-static')
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json'
    },
    body
  })
  if (!res.ok) {
    // Body can contain tokens or sensitive IdP error meta — log a code only.
    const code = await safeErrorCode(res)
    console.error(`[oauth-static] token ${phase} failed: HTTP ${res.status}${code ? ` (${code})` : ''}`)
    throw new OAuthStaticError(phase, res.status, code)
  }
  return (await res.json()) as TokenResponse
}

/** Pull only the machine `error` code out of an error body — never the description. */
async function safeErrorCode(res: Response): Promise<string | null> {
  try {
    const j = (await res.clone().json()) as { error?: unknown }
    return typeof j.error === 'string' ? j.error : null
  } catch {
    return null
  }
}

async function openClientSecret(env: Env, oauth: StaticOAuth): Promise<string | null> {
  if (!oauth.clientSecretCiphertext) return null
  return openSecret(sealedFromString(oauth.clientSecretCiphertext), env.ENCRYPTION_KEY)
}

function toOAuthTokens(json: TokenResponse): OAuthTokens {
  if (!json.access_token) throw new Error('oauth_static_no_access_token')
  return {
    access_token: json.access_token,
    token_type: json.token_type ?? 'Bearer',
    expires_in: json.expires_in,
    refresh_token: json.refresh_token,
    scope: json.scope
  }
}

function scopeString(oauth: StaticOAuth): string | undefined {
  return oauth.scopes && oauth.scopes.length > 0 ? oauth.scopes.join(' ') : undefined
}

function requireField(v: string | undefined, name: string): string {
  if (!v) throw new Error(`oauth_static_missing_${name}`)
  return v
}

function randomVerifier(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)))
}

async function s256Challenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64Url(new Uint8Array(digest))
}

function base64Url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
