import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { OAuthProvider, getOAuthApi } from '@cloudflare/workers-oauth-provider'
import { describe, expect, it } from 'vitest'
import type { Env as WorkerEnv } from '../../src/env'
import { oauthProviderOptions } from '../../src/oauth/provider-config'
import { MCP_LOGIN_IDLE_DAYS, stampTokenExchange } from '../../src/oauth/login-activity'

/**
 * Security properties this deployment DELEGATES to
 * `@cloudflare/workers-oauth-provider` — PKCE enforcement, redirect_uri
 * matching, authorization-code single-use. The 2026-07 review flagged them
 * as delegated-and-unverifiable (the library is not vendored, so nothing
 * in-repo asserted them). These tests run the real provider against real
 * KV in workerd, so a library upgrade that regresses any of them fails CI
 * instead of shipping.
 *
 * The flow mirrors production exactly: clients register through the real
 * /oauth/register endpoint, the authorize leg uses the same
 * parseAuthRequest/completeAuthorization helper pair the IdP callback
 * bridge uses (idp/complete-mcp.ts), and codes are exchanged at the real
 * /oauth/token endpoint.
 */

const BASE = 'https://ctxlayer-oauth-sec.test'
const REDIRECT = 'https://client.example/callback'
const OTHER_REDIRECT = 'https://evil.example/steal'

const testEnv = env as unknown as WorkerEnv

// Stub default handler: these tests only exercise the provider's own
// endpoints, so the fallthrough should never be reached.
// Built WITH `testEnv`, exactly as index.ts does per request, so the token
// endpoint also runs the login-activity `tokenExchangeCallback` here.
const provider = new OAuthProvider<WorkerEnv>(
  oauthProviderOptions(
    {
      fetch: () => Promise.resolve(new Response('unexpected fallthrough', { status: 500 }))
    },
    testEnv
  )
)

async function pfetch(input: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext()
  const res = await provider.fetch(new Request(input, init), testEnv, ctx)
  await waitOnExecutionContext(ctx)
  return res
}

async function registerPublicClient(): Promise<string> {
  const res = await pfetch(`${BASE}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'sec-test-client',
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code']
    })
  })
  expect(res.status).toBe(201)
  const body = (await res.json()) as { client_id: string }
  return body.client_id
}

function b64url(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

async function s256(verifier: string): Promise<string> {
  return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
}

function authorizeUrl(
  clientId: string,
  opts: { challenge?: string; redirectUri?: string } = {}
): string {
  const url = new URL(`${BASE}/oauth/authorize`)
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('redirect_uri', opts.redirectUri ?? REDIRECT)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', 'mcp')
  url.searchParams.set('state', 'st-1')
  if (opts.challenge) {
    url.searchParams.set('code_challenge', opts.challenge)
    url.searchParams.set('code_challenge_method', 'S256')
  }
  return url.toString()
}

/**
 * Run the server-side authorize leg the way production does: parse the
 * authorize request, then complete it for a signed-in user. Returns the
 * `code` the client would receive on its redirect_uri.
 */
async function issueCode(
  clientId: string,
  opts: { challenge?: string; redirectUri?: string } = {}
): Promise<string> {
  const helpers = getOAuthApi<WorkerEnv>(oauthProviderOptions(), testEnv)
  const authReq = await helpers.parseAuthRequest(new Request(authorizeUrl(clientId, opts)))
  const { redirectTo } = await helpers.completeAuthorization({
    request: authReq,
    userId: 'u-sec',
    metadata: { idp: 'github', email: 'sec@test.example' },
    scope: ['mcp'],
    props: { userId: 'u-sec', email: 'sec@test.example', role: 'member' }
  })
  const code = new URL(redirectTo).searchParams.get('code')
  if (!code) throw new Error(`no code on redirect: ${redirectTo}`)
  return code
}

async function exchange(
  clientId: string,
  code: string,
  opts: { verifier?: string; redirectUri?: string } = {}
): Promise<Response> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: opts.redirectUri ?? REDIRECT,
    client_id: clientId
  })
  if (opts.verifier) body.set('code_verifier', opts.verifier)
  return pfetch(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  })
}

describe('workers-oauth-provider delegated security properties', () => {
  it('happy path: PKCE S256 flow issues a usable access token (harness guard)', async () => {
    const clientId = await registerPublicClient()
    const verifier = 'sec-test-verifier-0123456789-0123456789-0123456789'
    const code = await issueCode(clientId, { challenge: await s256(verifier) })

    const res = await exchange(clientId, code, { verifier })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(typeof body.access_token).toBe('string')
    expect(String(body.token_type).toLowerCase()).toBe('bearer')
  })

  it('authorization codes are single-use: replay is rejected', async () => {
    const clientId = await registerPublicClient()
    const verifier = 'sec-test-verifier-replay-0123456789-0123456789-01'
    const code = await issueCode(clientId, { challenge: await s256(verifier) })

    expect((await exchange(clientId, code, { verifier })).status).toBe(200)
    const replay = await exchange(clientId, code, { verifier })
    expect(replay.status).toBeGreaterThanOrEqual(400)
    const body = (await replay.json()) as { error?: string }
    expect(body.error).toBe('invalid_grant')
  })

  it('PKCE: a wrong verifier is rejected', async () => {
    const clientId = await registerPublicClient()
    const code = await issueCode(clientId, {
      challenge: await s256('sec-test-verifier-right-0123456789-0123456789')
    })
    const res = await exchange(clientId, code, {
      verifier: 'sec-test-verifier-wrong-0123456789-0123456789-0'
    })
    expect(res.status).toBeGreaterThanOrEqual(400)
  })

  it('PKCE: omitting the verifier at token time is rejected', async () => {
    const clientId = await registerPublicClient()
    const code = await issueCode(clientId, {
      challenge: await s256('sec-test-verifier-omit-0123456789-0123456789-')
    })
    const res = await exchange(clientId, code)
    expect(res.status).toBeGreaterThanOrEqual(400)
  })

  it('PKCE: a public client cannot run the code flow without PKCE at all', async () => {
    const clientId = await registerPublicClient()
    // The provider may reject at parse/complete (no challenge on the
    // authorize request) or at token time — either satisfies the property
    // that no PKCE-less code flow completes for a public client.
    let code: string
    try {
      code = await issueCode(clientId, {})
    } catch {
      return // rejected at the authorize leg
    }
    const res = await exchange(clientId, code)
    expect(res.status).toBeGreaterThanOrEqual(400)
  })

  it('redirect_uri: an unregistered redirect_uri never receives a code', async () => {
    const clientId = await registerPublicClient()
    // Property: the authorize leg must refuse to mint a redirect to a URI
    // the client did not register — wherever in parse/complete it rejects.
    await expect(
      issueCode(clientId, {
        challenge: await s256('sec-test-verifier-redir-0123456789-01234567'),
        redirectUri: OTHER_REDIRECT
      })
    ).rejects.toThrow()
  })

  it('redirect_uri: token exchange with a mismatched redirect_uri is rejected', async () => {
    const clientId = await registerPublicClient()
    const verifier = 'sec-test-verifier-tokredir-0123456789-012345678'
    const code = await issueCode(clientId, { challenge: await s256(verifier) })
    const res = await exchange(clientId, code, { verifier, redirectUri: OTHER_REDIRECT })
    expect(res.status).toBeGreaterThanOrEqual(400)
  })
})

/**
 * Not a delegated property but a CONFIGURED one, asserted through the same
 * real-provider harness: this deployment turns the library's ABSOLUTE login
 * expiry OFF and runs a sliding session instead.
 *
 * The library stamps `grant.expiresAt` once, at the code exchange, and never
 * slides it on refresh (its 30-day default forced a monthly re-login on
 * every client — 2026-09-17 field finding: both of a day's rejected
 * refreshes were exact 30-day expiries); `clientRegistrationTTL` capped the
 * login the same way from the registration moment. Passing both as
 * `undefined` is what removes the cliff, and it is a silent, invisible
 * setting — dropping it (or a library default change) would quietly put
 * every user back on a fixed re-login clock, so it is pinned here.
 *
 * What replaces it — the idle sweep — is covered by grant-idle-sweep.test.ts.
 */
describe('MCP login lifetime (sliding, not absolute)', () => {
  it('a new login carries no absolute expiry', async () => {
    const clientId = await registerPublicClient()
    const verifier = 'sec-test-verifier-ttl-0123456789-0123456789-0123'
    const code = await issueCode(clientId, { challenge: await s256(verifier) })
    expect((await exchange(clientId, code, { verifier })).status).toBe(200)

    const helpers = getOAuthApi<WorkerEnv>(oauthProviderOptions(), testEnv)
    const grants = (await helpers.listUserGrants('u-sec')).items.filter(
      (g) => g.clientId === clientId
    )
    expect(grants).toHaveLength(1)
    expect(grants[0]?.expiresAt).toBeUndefined()
  })

  it('neither the grant nor the client record is written with a KV expiration', async () => {
    const clientId = await registerPublicClient()
    const verifier = 'sec-test-verifier-kvttl-0123456789-0123456789-01'
    const code = await issueCode(clientId, { challenge: await s256(verifier) })
    expect((await exchange(clientId, code, { verifier })).status).toBe(200)

    const helpers = getOAuthApi<WorkerEnv>(oauthProviderOptions(), testEnv)
    const grantId = (await helpers.listUserGrants('u-sec')).items.find(
      (g) => g.clientId === clientId
    )?.id
    expect(grantId).toBeTruthy()

    // Scoped to THIS login's two records: other tests in this file leave
    // behind never-exchanged grants, which legitimately still carry the
    // authorization code's short TTL. A key stored without a TTL lists with
    // no expiration (null here, undefined on the platform); the 1-hour
    // access-token key is the contrast.
    for (const prefix of [`grant:u-sec:${grantId}`, `client:${clientId}`]) {
      const { keys } = await testEnv.OAUTH_KV.list({ prefix })
      expect(keys).toHaveLength(1)
      expect(keys[0]?.expiration ?? null).toBeNull()
    }
  })

  it('every token exchange stamps the login-activity ledger, once per grant', async () => {
    const clientId = await registerPublicClient()
    const verifier = 'sec-test-verifier-stamp-0123456789-0123456789-01'
    const code = await issueCode(clientId, { challenge: await s256(verifier) })
    const tokens = (await (await exchange(clientId, code, { verifier })).json()) as {
      refresh_token: string
    }

    const read = async () =>
      (
        await testEnv.DB.prepare(
          `SELECT grant_id, user_id, created_at, last_refresh_at FROM oauth_grant_activity
            WHERE client_id = ?1`
        )
          .bind(clientId)
          .all<{ grant_id: string; user_id: string; created_at: number; last_refresh_at: number }>()
      ).results ?? []

    const afterExchange = await read()
    expect(afterExchange).toHaveLength(1)
    expect(afterExchange[0]?.user_id).toBe('u-sec')
    const grantId = afterExchange[0]!.grant_id

    const refreshed = await pfetch(`${BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id: clientId
      }).toString()
    })
    expect(refreshed.status).toBe(200)

    // Still ONE row — the stamp is an upsert keyed on the grant, not a log.
    const afterRefresh = await read()
    expect(afterRefresh).toHaveLength(1)
    expect(afterRefresh[0]?.grant_id).toBe(grantId)

    // And a later exchange moves the idle clock without rewriting the
    // original authorization moment — the whole basis of the sweep.
    const later = afterRefresh[0]!.created_at + 3600
    await stampTokenExchange(testEnv, { grantId, userId: 'u-sec', clientId }, later)
    const afterStamp = await read()
    expect(afterStamp[0]?.last_refresh_at).toBe(later)
    expect(afterStamp[0]?.created_at).toBe(afterRefresh[0]?.created_at)
  })

  it('the idle window is a policy constant, not a library default', () => {
    expect(MCP_LOGIN_IDLE_DAYS).toBe(90)
  })
})

