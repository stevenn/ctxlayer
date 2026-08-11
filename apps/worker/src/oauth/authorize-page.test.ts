import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Stub the collaborators so the tests drive the branch logic in
// handleAuthorize / handleAuthorizeDecision without the real JWKS fetch /
// D1 / OAuth provider. `verifyCfAccessJwt` is mocked but
// `accessTrustConfigured` is kept real (it only reads env), so the
// "Access not configured" path is exercised genuinely. `vi.hoisted` makes
// the stubs available to the hoisted `vi.mock` factories below.
const { verifyCfAccessJwt, upsertUser, completeMcpAuthorization } = vi.hoisted(() => ({
  verifyCfAccessJwt: vi.fn(),
  upsertUser: vi.fn(),
  completeMcpAuthorization: vi.fn()
}))

vi.mock('../auth/cf-access', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auth/cf-access')>()
  return { ...actual, verifyCfAccessJwt }
})
vi.mock('../db/queries/users', () => ({ upsertUser }))
vi.mock('../idp/complete-mcp', () => ({ completeMcpAuthorization }))

import { handleAuthorize, handleAuthorizeDecision } from './authorize-page'
import type { Env } from '../env'

const PARSED_AUTH_REQ = {
  clientId: 'client-1',
  redirectUri: 'https://client.example/cb',
  state: 'st-1'
}

function fakeEnv(over: Partial<Env> = {}): Env {
  return {
    CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
    CF_ACCESS_AUD: 'aud-tag',
    ALLOWED_GITHUB_ORG: 'my-org',
    OAUTH_KV: {
      put: vi.fn(async () => {}),
      get: vi.fn(async () => JSON.stringify(PARSED_AUTH_REQ)),
      delete: vi.fn(async () => {})
    },
    OAUTH_PROVIDER: {
      parseAuthRequest: vi.fn(async () => PARSED_AUTH_REQ),
      lookupClient: vi.fn(async () => ({ clientName: 'Test Client' }))
    },
    ...over
  } as unknown as Env
}

function authorizeReq(headers: Record<string, string> = {}): Request {
  return new Request(
    'https://mcp.acme.example/oauth/authorize?response_type=code&client_id=client-1',
    { headers }
  )
}

function decisionReq(
  fields: Record<string, string>,
  headers: Record<string, string> = {}
): Request {
  return new Request('https://mcp.acme.example/oauth/authorize/decision', {
    method: 'POST',
    body: new URLSearchParams(fields),
    headers
  })
}

const activeUser = {
  id: 'u1',
  email: 'user@acme.example',
  name: null,
  avatar_url: null,
  idp: 'access',
  idp_sub: 'sub-1',
  role: 'user',
  status: 'active',
  created_at: 0,
  last_seen_at: 0,
  session_epoch: 0
}

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.restoreAllMocks())

describe('handleAuthorize — consent interstitial (§1e)', () => {
  it('names the client, the return host, and the grant on the IdP page', async () => {
    const env = fakeEnv({ CF_ACCESS_AUD: undefined })
    const res = await handleAuthorize(authorizeReq(), env)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('Test Client')
    expect(html).toContain('client.example')
    expect(html).toContain('acting as you')
    expect(html).toContain('Approve &amp; continue with GitHub')
    expect(html).toContain('value="deny"')
  })

  it('renders a local 400 when the provider rejects the authorize request', async () => {
    const env = fakeEnv()
    ;(env.OAUTH_PROVIDER.parseAuthRequest as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('unregistered redirect_uri')
    )
    const res = await handleAuthorize(authorizeReq(), env)
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('Invalid authorization request')
  })
})

describe('handleAuthorize — Cloudflare Access branch', () => {
  it('shows Approve/Deny (no IdP chooser) to an Access-verified user by default', async () => {
    const env = fakeEnv()
    verifyCfAccessJwt.mockResolvedValue({ sub: 'sub-1', email: 'user@acme.example', name: null })

    const res = await handleAuthorize(authorizeReq({ 'cf-access-jwt-assertion': 'tok' }), env)

    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('value="approve"')
    expect(html).toContain('value="deny"')
    expect(html).not.toContain('/idp/github/start')
    expect(completeMcpAuthorization).not.toHaveBeenCalled()
  })

  it('completes zero-click when OAUTH_CONSENT_SKIP_VIA_ACCESS is set', async () => {
    const env = fakeEnv({ OAUTH_CONSENT_SKIP_VIA_ACCESS: '1' })
    verifyCfAccessJwt.mockResolvedValue({ sub: 'sub-1', email: 'user@acme.example', name: null })
    upsertUser.mockResolvedValue({ user: activeUser, promotedToAdmin: false })
    const completed = new Response(null, {
      status: 302,
      headers: { Location: 'https://client.example/cb?code=abc' }
    })
    completeMcpAuthorization.mockResolvedValue(completed)

    const res = await handleAuthorize(authorizeReq({ 'cf-access-jwt-assertion': 'tok' }), env)

    expect(res).toBe(completed)
    // upsert is admitted as idp='access', active, never running the local allowlist.
    expect(upsertUser).toHaveBeenCalledWith(
      env,
      { idp: 'access', idpSub: 'sub-1', email: 'user@acme.example', name: null, avatarUrl: null },
      'active'
    )
    // The grant is completed against the SAME request id stashed in KV.
    const putKey = (env.OAUTH_KV.put as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string
    const storedId = putKey.replace('authReq:', '')
    expect(completeMcpAuthorization).toHaveBeenCalledWith(
      env,
      storedId,
      expect.objectContaining({ id: 'u1' })
    )
  })

  it('falls back to the IdP consent page when no Access token is present', async () => {
    const env = fakeEnv()

    const res = await handleAuthorize(authorizeReq(), env)

    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Approve &amp; continue with GitHub')
    expect(verifyCfAccessJwt).not.toHaveBeenCalled()
    expect(completeMcpAuthorization).not.toHaveBeenCalled()
  })

  it('falls back to the consent page when the Access token fails verification', async () => {
    const env = fakeEnv()
    verifyCfAccessJwt.mockResolvedValue(null)

    const res = await handleAuthorize(authorizeReq({ 'cf-access-jwt-assertion': 'bad' }), env)

    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Authorize')
    expect(verifyCfAccessJwt).toHaveBeenCalledOnce()
    expect(completeMcpAuthorization).not.toHaveBeenCalled()
  })

  it('blocks a suspended user and does NOT complete the grant (zero-click mode)', async () => {
    const env = fakeEnv({ OAUTH_CONSENT_SKIP_VIA_ACCESS: '1' })
    verifyCfAccessJwt.mockResolvedValue({ sub: 'sub-1', email: 'user@acme.example', name: null })
    upsertUser.mockResolvedValue({
      user: { ...activeUser, status: 'suspended' },
      promotedToAdmin: false
    })

    const res = await handleAuthorize(authorizeReq({ 'cf-access-jwt-assertion': 'tok' }), env)

    expect(res.status).toBe(403)
    expect(await res.text()).toContain('suspended')
    expect(completeMcpAuthorization).not.toHaveBeenCalled()
  })

  it('shows a pending message for a pending user (zero-click mode)', async () => {
    const env = fakeEnv({ OAUTH_CONSENT_SKIP_VIA_ACCESS: '1' })
    verifyCfAccessJwt.mockResolvedValue({ sub: 'sub-1', email: 'user@acme.example', name: null })
    upsertUser.mockResolvedValue({
      user: { ...activeUser, status: 'pending' },
      promotedToAdmin: false
    })

    const res = await handleAuthorize(authorizeReq({ 'cf-access-jwt-assertion': 'tok' }), env)

    expect(res.status).toBe(403)
    expect(await res.text()).toContain('awaiting administrator approval')
    expect(completeMcpAuthorization).not.toHaveBeenCalled()
  })

  it('skips Access entirely when trust is not configured, even with a token present', async () => {
    const env = fakeEnv({ CF_ACCESS_AUD: undefined })

    const res = await handleAuthorize(authorizeReq({ 'cf-access-jwt-assertion': 'tok' }), env)

    expect(res.status).toBe(200)
    expect(verifyCfAccessJwt).not.toHaveBeenCalled()
    expect(completeMcpAuthorization).not.toHaveBeenCalled()
  })
})

describe('handleAuthorizeDecision', () => {
  it('deny bounces to the validated redirect_uri with error=access_denied + state', async () => {
    const env = fakeEnv()
    const res = await handleAuthorizeDecision(
      decisionReq({ request_id: 'req-1', choice: 'deny' }),
      env
    )
    expect(res.status).toBe(302)
    const loc = new URL(res.headers.get('location') ?? '')
    expect(loc.origin + loc.pathname).toBe('https://client.example/cb')
    expect(loc.searchParams.get('error')).toBe('access_denied')
    expect(loc.searchParams.get('state')).toBe('st-1')
    // Single-use: the stashed request is consumed.
    expect(env.OAUTH_KV.delete).toHaveBeenCalledWith('authReq:req-1')
  })

  it('deny of an expired/consumed request renders the local 400 (no open redirect)', async () => {
    const env = fakeEnv()
    ;(env.OAUTH_KV.get as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    const res = await handleAuthorizeDecision(
      decisionReq({ request_id: 'req-x', choice: 'deny' }),
      env
    )
    expect(res.status).toBe(400)
  })

  it('approve with a valid Access identity completes the grant', async () => {
    const env = fakeEnv()
    verifyCfAccessJwt.mockResolvedValue({ sub: 'sub-1', email: 'user@acme.example', name: null })
    upsertUser.mockResolvedValue({ user: activeUser, promotedToAdmin: false })
    const completed = new Response(null, { status: 302 })
    completeMcpAuthorization.mockResolvedValue(completed)

    const res = await handleAuthorizeDecision(
      decisionReq({ request_id: 'req-1', choice: 'approve' }, { 'cf-access-jwt-assertion': 'tok' }),
      env
    )
    expect(res).toBe(completed)
    expect(completeMcpAuthorization).toHaveBeenCalledWith(
      env,
      'req-1',
      expect.objectContaining({ id: 'u1' })
    )
  })

  it('approve without Access trust configured is a 400 (IdP deploys approve via the IdP leg)', async () => {
    const env = fakeEnv({ CF_ACCESS_AUD: undefined })
    const res = await handleAuthorizeDecision(
      decisionReq({ request_id: 'req-1', choice: 'approve' }),
      env
    )
    expect(res.status).toBe(400)
    expect(completeMcpAuthorization).not.toHaveBeenCalled()
  })

  it('approve with a bad Access token is a 403', async () => {
    const env = fakeEnv()
    verifyCfAccessJwt.mockResolvedValue(null)
    const res = await handleAuthorizeDecision(
      decisionReq({ request_id: 'req-1', choice: 'approve' }, { 'cf-access-jwt-assertion': 'bad' }),
      env
    )
    expect(res.status).toBe(403)
    expect(completeMcpAuthorization).not.toHaveBeenCalled()
  })

  it('rejects a cross-site POST outright', async () => {
    const env = fakeEnv()
    const res = await handleAuthorizeDecision(
      decisionReq({ request_id: 'req-1', choice: 'deny' }, { 'sec-fetch-site': 'cross-site' }),
      env
    )
    expect(res.status).toBe(403)
    expect(env.OAUTH_KV.get).not.toHaveBeenCalled()
  })

  it('rejects an unknown choice', async () => {
    const env = fakeEnv()
    const res = await handleAuthorizeDecision(
      decisionReq({ request_id: 'req-1', choice: 'maybe' }),
      env
    )
    expect(res.status).toBe(400)
  })
})
