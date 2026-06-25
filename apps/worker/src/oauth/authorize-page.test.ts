import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Stub the collaborators so the test drives the branch logic in handleAuthorize
// without the real JWKS fetch / D1 / OAuth provider. `verifyCfAccessJwt` is
// mocked but `accessTrustConfigured` is kept real (it only reads env), so the
// "Access not configured" path is exercised genuinely. `vi.hoisted` makes the
// stubs available to the hoisted `vi.mock` factories below.
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

import { handleAuthorize } from './authorize-page'
import type { Env } from '../env'

function fakeEnv(over: Partial<Env> = {}): Env {
  return {
    CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
    CF_ACCESS_AUD: 'aud-tag',
    ALLOWED_GITHUB_ORG: 'my-org',
    OAUTH_KV: { put: vi.fn(async () => {}) },
    OAUTH_PROVIDER: {
      parseAuthRequest: vi.fn(async () => ({ clientId: 'client-1' })),
      lookupClient: vi.fn(async () => ({ clientName: 'Test Client' }))
    },
    ...over
  } as unknown as Env
}

function authorizeReq(headers: Record<string, string> = {}): Request {
  return new Request(
    'https://mcp.yukitools.dev/oauth/authorize?response_type=code&client_id=client-1',
    { headers }
  )
}

const activeUser = {
  id: 'u1',
  email: 'user@yuki.be',
  name: null,
  avatar_url: null,
  idp: 'access',
  idp_sub: 'sub-1',
  role: 'user',
  status: 'active',
  created_at: 0,
  last_seen_at: 0
}

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.restoreAllMocks())

describe('handleAuthorize — Cloudflare Access branch', () => {
  it('completes the grant from a valid Access token, reusing the stashed request id', async () => {
    const env = fakeEnv()
    verifyCfAccessJwt.mockResolvedValue({ sub: 'sub-1', email: 'user@yuki.be', name: null })
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
      { idp: 'access', idpSub: 'sub-1', email: 'user@yuki.be', name: null, avatarUrl: null },
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

  it('falls back to the IdP chooser when no Access token is present', async () => {
    const env = fakeEnv()

    const res = await handleAuthorize(authorizeReq(), env)

    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Sign in with GitHub')
    expect(verifyCfAccessJwt).not.toHaveBeenCalled()
    expect(completeMcpAuthorization).not.toHaveBeenCalled()
  })

  it('falls back to the chooser when the Access token fails verification', async () => {
    const env = fakeEnv()
    verifyCfAccessJwt.mockResolvedValue(null)

    const res = await handleAuthorize(authorizeReq({ 'cf-access-jwt-assertion': 'bad' }), env)

    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Authorize')
    expect(verifyCfAccessJwt).toHaveBeenCalledOnce()
    expect(completeMcpAuthorization).not.toHaveBeenCalled()
  })

  it('blocks a suspended user and does NOT complete the grant', async () => {
    const env = fakeEnv()
    verifyCfAccessJwt.mockResolvedValue({ sub: 'sub-1', email: 'user@yuki.be', name: null })
    upsertUser.mockResolvedValue({
      user: { ...activeUser, status: 'suspended' },
      promotedToAdmin: false
    })

    const res = await handleAuthorize(authorizeReq({ 'cf-access-jwt-assertion': 'tok' }), env)

    expect(res.status).toBe(403)
    expect(await res.text()).toContain('suspended')
    expect(completeMcpAuthorization).not.toHaveBeenCalled()
  })

  it('shows a pending message for a pending user', async () => {
    const env = fakeEnv()
    verifyCfAccessJwt.mockResolvedValue({ sub: 'sub-1', email: 'user@yuki.be', name: null })
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
