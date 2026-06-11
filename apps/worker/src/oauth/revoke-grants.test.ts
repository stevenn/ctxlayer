import { describe, expect, it, vi, beforeEach } from 'vitest'

const listUserGrants = vi.fn()
const revokeGrant = vi.fn()

// Stub the SDK + provider-config so the test drives the grant sweep without
// loading the whole OAuth/MCP stack.
vi.mock('@cloudflare/workers-oauth-provider', () => ({
  getOAuthApi: () => ({ listUserGrants, revokeGrant })
}))
vi.mock('./provider-config', () => ({ oauthProviderOptions: () => ({}) }))

import { revokeAllUserGrants } from './revoke-grants'
import type { Env } from '../env'

const env = {} as Env

beforeEach(() => {
  vi.clearAllMocks()
  revokeGrant.mockResolvedValue(undefined)
})

describe('revokeAllUserGrants', () => {
  it('revokes every grant across all pages', async () => {
    listUserGrants
      .mockResolvedValueOnce({ items: [{ id: 'g1' }, { id: 'g2' }], cursor: 'c1' })
      .mockResolvedValueOnce({ items: [{ id: 'g3' }], cursor: undefined })

    const r = await revokeAllUserGrants(env, 'u1')

    expect(r).toEqual({ revoked: 3, complete: true })
    expect(listUserGrants).toHaveBeenCalledTimes(2)
    expect(revokeGrant).toHaveBeenCalledWith('g1', 'u1')
    expect(revokeGrant).toHaveBeenCalledWith('g3', 'u1')
  })

  it('counts only successes and reports incomplete on a per-grant failure', async () => {
    listUserGrants.mockResolvedValueOnce({ items: [{ id: 'g1' }, { id: 'g2' }], cursor: undefined })
    revokeGrant.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('kv down'))

    const r = await revokeAllUserGrants(env, 'u1')

    expect(r).toEqual({ revoked: 1, complete: false })
  })

  it('swallows a total list failure (status change is the real lockout)', async () => {
    listUserGrants.mockRejectedValueOnce(new Error('kv unavailable'))

    const r = await revokeAllUserGrants(env, 'u1')

    expect(r).toEqual({ revoked: 0, complete: false })
    expect(revokeGrant).not.toHaveBeenCalled()
  })
})
