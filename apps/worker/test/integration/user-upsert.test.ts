import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { EmailOnOtherIdpError, upsertUser } from '../../src/db/queries/users'
import type { Env as WorkerEnv } from '../../src/env'

/**
 * upsertUser against a real D1. The conflict target is (idp, idp_sub);
 * UNIQUE(users.email) is a SEPARATE constraint that used to surface as an
 * unhandled 500 when the same email arrived under a different IdP (the
 * GitHub-user-behind-Cloudflare-Access migration case). Pin the typed error.
 */

const testEnv = env as unknown as WorkerEnv

const ghIdentity = {
  idp: 'github' as const,
  idpSub: 'gh-123',
  email: 'steven@example.com',
  name: 'Steven',
  avatarUrl: null
}

describe('upsertUser', () => {
  it('re-upserts the same (idp, idp_sub) identity without error', async () => {
    const first = await upsertUser(testEnv, ghIdentity, 'active')
    const second = await upsertUser(
      testEnv,
      { ...ghIdentity, name: 'Steven N', email: 'steven@example.com' },
      'active'
    )
    expect(second.user.id).toBe(first.user.id)
    expect(second.user.name).toBe('Steven N')
  })

  it('throws EmailOnOtherIdpError when the email belongs to another IdP identity', async () => {
    await upsertUser(testEnv, ghIdentity, 'active')
    await expect(
      upsertUser(
        testEnv,
        { idp: 'access', idpSub: 'entra-999', email: 'steven@example.com', name: null, avatarUrl: null },
        'active'
      )
    ).rejects.toBeInstanceOf(EmailOnOtherIdpError)
  })

  it('admits a different email on another IdP as a new user', async () => {
    await upsertUser(testEnv, ghIdentity, 'active')
    const other = await upsertUser(
      testEnv,
      { idp: 'access', idpSub: 'entra-999', email: 'other@example.com', name: null, avatarUrl: null },
      'active'
    )
    expect(other.user.idp).toBe('access')
    expect(other.user.status).toBe('active')
  })
})
