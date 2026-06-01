import pc from 'picocolors'
import { CtxlayerError } from '../errors'
import { newPkce, newState } from '../auth/pkce'
import { startLoopback } from '../auth/loopback'
import { saveCredentials, loadCredentials } from '../auth/token-store'
import { openUrl } from '../browser'

/**
 * OAuth login flow:
 *   1. Discover OAuth metadata at /.well-known/oauth-authorization-server.
 *   2. Spawn loopback server on an ephemeral port for the redirect URI.
 *   3. DCR: POST /oauth/register with the loopback URI.
 *   4. Open browser at /oauth/authorize with PKCE challenge.
 *   5. Receive code on loopback, exchange via /oauth/token.
 *   6. Persist credentials to per-OS configDir().
 */
export async function loginCommand(opts: { baseUrl?: string; force?: boolean }): Promise<void> {
  const existing = await loadCredentials()
  if (existing && !opts.force) {
    console.log(
      pc.green('✓'),
      `Already logged in as ${existing.userEmail ?? '(unknown)'} on ${existing.baseUrl}.`
    )
    console.log('  Use', pc.cyan('ctxlayer login --force'), 'to re-authenticate.')
    return
  }

  const baseUrl = (opts.baseUrl ?? existing?.baseUrl ?? process.env.CTXLAYER_BASE_URL)?.replace(
    /\/$/,
    ''
  )
  if (!baseUrl) {
    throw new CtxlayerError(
      'No base URL provided. Use --base-url=https://… or set CTXLAYER_BASE_URL.',
      'missing_base_url'
    )
  }

  console.log('Discovering OAuth metadata at', pc.cyan(baseUrl), '…')
  const meta = await fetchOAuthMetadata(baseUrl)

  console.log('Starting loopback server …')
  const loopback = await startLoopback()
  const redirectUri = `http://127.0.0.1:${loopback.port}/cb`

  console.log('Registering CLI client (DCR) …')
  const dcr = await dcrRegister(meta.registration_endpoint, redirectUri)

  const pkce = newPkce()
  const state = newState()
  const authUrl = new URL(meta.authorization_endpoint)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('client_id', dcr.client_id)
  authUrl.searchParams.set('redirect_uri', redirectUri)
  authUrl.searchParams.set('code_challenge', pkce.challenge)
  authUrl.searchParams.set('code_challenge_method', 'S256')
  authUrl.searchParams.set('state', state)
  authUrl.searchParams.set('scope', 'mcp')

  console.log('Opening browser for sign-in …')
  console.log('  If it doesn’t open automatically:')
  console.log(' ', pc.cyan(authUrl.toString()))
  openUrl(authUrl.toString())

  const { code, state: gotState } = await loopback.waitForCode()
  if (gotState !== state) {
    throw new CtxlayerError('OAuth state mismatch — aborting.', 'state_mismatch')
  }

  console.log('Exchanging code for tokens …')
  const tokens = await exchangeCode({
    tokenEndpoint: meta.token_endpoint,
    code,
    codeVerifier: pkce.verifier,
    clientId: dcr.client_id,
    redirectUri
  })

  await saveCredentials({
    baseUrl,
    clientId: dcr.client_id,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? '',
    expiresAt: Math.floor(Date.now() / 1000) + tokens.expires_in
  })

  console.log(pc.green('✓'), 'Logged in. Credentials saved.')
  console.log(
    '  Try',
    pc.cyan('ctxlayer pull'),
    'to materialise skills under ~/.claude/skills/ctxlayer/.'
  )
}

interface OAuthMetadata {
  authorization_endpoint: string
  token_endpoint: string
  registration_endpoint: string
}

async function fetchOAuthMetadata(baseUrl: string): Promise<OAuthMetadata> {
  const res = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`)
  if (!res.ok) {
    throw new CtxlayerError(
      `OAuth metadata fetch failed (HTTP ${res.status}). Is ${baseUrl} a ctxlayer install?`,
      'oauth_metadata_failed'
    )
  }
  const body = (await res.json()) as Partial<OAuthMetadata>
  if (!body.authorization_endpoint || !body.token_endpoint || !body.registration_endpoint) {
    throw new CtxlayerError(
      'OAuth metadata missing required endpoints (authorize/token/register).',
      'oauth_metadata_incomplete'
    )
  }
  return body as OAuthMetadata
}

async function dcrRegister(
  registrationEndpoint: string,
  redirectUri: string
): Promise<{ client_id: string }> {
  const res = await fetch(registrationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'ctxlayer CLI',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'mcp'
    })
  })
  if (!res.ok) {
    throw new CtxlayerError(
      `Dynamic client registration failed (HTTP ${res.status}).`,
      'dcr_failed'
    )
  }
  const body = (await res.json()) as { client_id?: string }
  if (!body.client_id) {
    throw new CtxlayerError(
      'Dynamic client registration returned no client_id.',
      'dcr_no_client_id'
    )
  }
  return { client_id: body.client_id }
}

interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
  token_type: string
}

async function exchangeCode(args: {
  tokenEndpoint: string
  code: string
  codeVerifier: string
  clientId: string
  redirectUri: string
}): Promise<TokenResponse> {
  const res = await fetch(args.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: args.code,
      code_verifier: args.codeVerifier,
      client_id: args.clientId,
      redirect_uri: args.redirectUri
    })
  })
  if (!res.ok) {
    // Don't log the body — token-exchange responses can carry detailed
    // error metadata that's better logged server-side only.
    throw new CtxlayerError(`Token exchange failed (HTTP ${res.status}).`, 'token_exchange_failed')
  }
  return (await res.json()) as TokenResponse
}
