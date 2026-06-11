import { afterEach, describe, expect, it, vi } from 'vitest'
import { isStaticOAuthConfig, type UpstreamAuthConfig } from '@ctxlayer/shared'
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import {
  buildAuthorizeRedirect,
  exchangeCode,
  refreshStatic,
  staticOAuth,
  type StaticFlowProvider,
  type StaticOAuth
} from './oauth-static'

const ENTRA: StaticOAuth = {
  clientId: 'app-123',
  authorizeUrl: 'https://login.microsoftonline.com/tid/oauth2/v2.0/authorize',
  tokenUrl: 'https://login.microsoftonline.com/tid/oauth2/v2.0/token',
  scopes: ['499b84ac-1321-427f-aa17-267ca6975798/.default', 'offline_access']
}

// A fake provider that records the verifier + saved tokens, so the static
// flow can be exercised without KV / D1.
function fakeProvider(initial?: OAuthTokens): StaticFlowProvider & {
  saved?: OAuthTokens
  verifier?: string
} {
  const p: StaticFlowProvider & { saved?: OAuthTokens; verifier?: string } = {
    state: () => 'state-xyz',
    redirectUrl: 'https://ctx.example/api/upstreams/oauth/callback',
    saveCodeVerifier: async (v) => {
      p.verifier = v
    },
    codeVerifier: async () => p.verifier ?? 'verifier-abc',
    tokens: async () => initial,
    saveTokens: async (t) => {
      p.saved = t
    }
  }
  return p
}

const env = { ENCRYPTION_KEY: 'irrelevant-for-public-client' } as unknown as Parameters<
  typeof refreshStatic
>[0]

afterEach(() => vi.restoreAllMocks())

describe('isStaticOAuthConfig / staticOAuth', () => {
  it('detects a fully-specified pre-registered client', () => {
    expect(isStaticOAuthConfig({ oauth: ENTRA })).toBe(true)
    expect(staticOAuth({ oauth: ENTRA })).toEqual(ENTRA)
  })

  it('treats partial / DCR configs as non-static', () => {
    expect(isStaticOAuthConfig({})).toBe(false)
    expect(isStaticOAuthConfig({ oauth: { clientId: 'x' } })).toBe(false)
    expect(isStaticOAuthConfig({ oauth: { authorizeUrl: ENTRA.authorizeUrl } })).toBe(false)
    expect(staticOAuth({ oauth: { clientId: 'x' } })).toBeNull()
    expect(staticOAuth(undefined)).toBeNull()
  })
})

describe('buildAuthorizeRedirect', () => {
  it('emits an auth-code + PKCE(S256) URL and persists the verifier', async () => {
    const p = fakeProvider()
    const url = new URL(await buildAuthorizeRedirect(p, ENTRA))
    expect(url.origin + url.pathname).toBe(ENTRA.authorizeUrl)
    expect(url.searchParams.get('client_id')).toBe('app-123')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('redirect_uri')).toBe(p.redirectUrl)
    expect(url.searchParams.get('state')).toBe('state-xyz')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(url.searchParams.get('scope')).toBe(ENTRA.scopes?.join(' '))
    expect(p.verifier).toBeTruthy()
  })
})

describe('exchangeCode', () => {
  it('POSTs the authorization_code grant and saves the tokens', async () => {
    const p = fakeProvider()
    p.verifier = 'verifier-abc'
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'AT',
          refresh_token: 'RT',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'a b'
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    )
    await exchangeCode(env, p, ENTRA, 'the-code')
    expect(fetchMock).toHaveBeenCalledOnce()
    const call = fetchMock.mock.calls[0]
    expect(call?.[0]).toBe(ENTRA.tokenUrl)
    const body = new URLSearchParams(call?.[1]?.body as string)
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code')).toBe('the-code')
    expect(body.get('code_verifier')).toBe('verifier-abc')
    expect(body.get('redirect_uri')).toBe(p.redirectUrl)
    expect(body.get('client_id')).toBe('app-123')
    expect(p.saved?.access_token).toBe('AT')
    expect(p.saved?.refresh_token).toBe('RT')
  })

  it('throws (and does not save) on a non-2xx token response', async () => {
    const p = fakeProvider()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
    )
    await expect(exchangeCode(env, p, ENTRA, 'bad')).rejects.toThrow(/exchange_failed/)
    expect(p.saved).toBeUndefined()
  })
})

describe('refreshStatic', () => {
  it('returns a still-fresh access token without hitting the network', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const p = fakeProvider({
      access_token: 'fresh',
      token_type: 'Bearer',
      refresh_token: 'RT',
      expires_in: 3600
    })
    expect(await refreshStatic(env, p, ENTRA)).toBe('fresh')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refreshes via refresh_token grant when the access token is near expiry', async () => {
    const p = fakeProvider({
      access_token: 'stale',
      token_type: 'Bearer',
      refresh_token: 'RT',
      expires_in: 10
    })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'AT2', expires_in: 3600 }), { status: 200 })
    )
    expect(await refreshStatic(env, p, ENTRA)).toBe('AT2')
    const body = new URLSearchParams(fetchMock.mock.calls[0]?.[1]?.body as string)
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('refresh_token')).toBe('RT')
    expect(p.saved?.access_token).toBe('AT2')
  })

  it('returns null when there are no stored credentials', async () => {
    expect(await refreshStatic(env, fakeProvider(undefined), ENTRA)).toBeNull()
  })

  it('returns null (forcing re-auth) when the refresh is rejected', async () => {
    const p = fakeProvider({
      access_token: 'stale',
      token_type: 'Bearer',
      refresh_token: 'RT',
      expires_in: 10
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
    )
    expect(await refreshStatic(env, p, ENTRA)).toBeNull()
  })
})

// Guard the documented contract: every field present ⇒ static.
it('UpstreamAuthConfig type accepts the static oauth shape', () => {
  const cfg: UpstreamAuthConfig = { oauth: { ...ENTRA, clientSecretCiphertext: 'sealed' } }
  expect(staticOAuth(cfg)).not.toBeNull()
})
