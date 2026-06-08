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

export type StaticOAuth = NonNullable<UpstreamAuthConfig['oauth']>

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

/**
 * Return a usable access token for the proxy, refreshing via the
 * refresh_token grant when the stored one is near expiry. Returns null when
 * there's nothing usable (no creds, or the refresh was rejected) — the
 * caller then forces an interactive re-auth.
 */
export async function refreshStatic(
  env: Env,
  provider: StaticFlowProvider,
  oauth: StaticOAuth
): Promise<string | null> {
  const current = await provider.tokens()
  if (!current?.access_token && !current?.refresh_token) return null
  // Still-fresh access token: use as-is, don't rotate the refresh token.
  if (
    current?.access_token &&
    current.expires_in !== undefined &&
    current.expires_in > REFRESH_BUFFER_S
  ) {
    return current.access_token
  }
  if (!current?.refresh_token) {
    // Near/at expiry with no way to refresh — fall back to whatever access
    // token we have (may still work briefly) or signal re-auth.
    return current?.access_token ?? null
  }
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: current.refresh_token,
    client_id: requireField(oauth.clientId, 'clientId')
  })
  const scope = scopeString(oauth)
  if (scope) body.set('scope', scope)
  const json = await postToken(env, oauth, body, 'refresh').catch(() => null)
  if (!json) return null
  await provider.saveTokens(toOAuthTokens(json))
  return typeof json.access_token === 'string' ? json.access_token : null
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
  const res = await fetch(requireField(oauth.tokenUrl, 'tokenUrl'), {
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
    throw new Error(`oauth_static_${phase}_failed`)
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
