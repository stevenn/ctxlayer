import { env } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Env } from '../../src/env'
import {
  acquireRefreshLease,
  clearReauthRequired,
  getUserCredentialStatus,
  markReauthRequired
} from '../../src/db/queries/upstream-credentials'

/**
 * The refresh lease is the single-flight guard that stops two concurrent
 * sessions/devices from both spending the same rotating refresh_token. These
 * tests pin the compare-and-set semantics of `acquireRefreshLease` against a
 * real D1: exactly one caller wins while the lease is held, and the row
 * becomes claimable again once the lease deadline has passed.
 */

const testEnv = env as unknown as Env

async function seedCredentialRow(): Promise<void> {
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO users (id, email, idp, idp_sub, created_at)
       VALUES ('u-1', 'u1@example.test', 'github', 'gh-1', 0)`
    ),
    testEnv.DB.prepare(
      `INSERT INTO upstream_servers
         (id, slug, display_name, transport, url, auth_strategy, auth_config, created_at, updated_at)
       VALUES ('ups-1', 'up-x', 'Up X', 'streamable_http', 'https://x.test/mcp', 'user_oauth', '{}', 0, 0)`
    ),
    testEnv.DB.prepare(
      `INSERT INTO user_credentials
         (user_id, upstream_id, kind, ciphertext, iv, key_version, created_at, updated_at)
       VALUES ('u-1', 'ups-1', 'oauth', X'00', X'00', 1, 0, 0)`
    )
  ])
}

async function cleanup(): Promise<void> {
  await testEnv.DB.batch([
    testEnv.DB.prepare(`DELETE FROM user_credentials`),
    testEnv.DB.prepare(`DELETE FROM upstream_servers`),
    testEnv.DB.prepare(`DELETE FROM users`)
  ])
}

describe('acquireRefreshLease', () => {
  beforeEach(seedCredentialRow)
  afterEach(cleanup)

  it('lets exactly one caller hold the lease while it is live', async () => {
    expect(await acquireRefreshLease(testEnv, 'u-1', 'ups-1', 60)).toBe(true)
    // Held and not expired → every other caller loses.
    expect(await acquireRefreshLease(testEnv, 'u-1', 'ups-1', 60)).toBe(false)
    expect(await acquireRefreshLease(testEnv, 'u-1', 'ups-1', 60)).toBe(false)
  })

  it('becomes claimable again after the lease deadline passes', async () => {
    expect(await acquireRefreshLease(testEnv, 'u-1', 'ups-1', 60)).toBe(true)
    // Simulate the lease having expired (a crashed/slow holder).
    await testEnv.DB.prepare(
      `UPDATE user_credentials SET refresh_lock_until = 1 WHERE user_id = 'u-1' AND upstream_id = 'ups-1'`
    ).run()
    expect(await acquireRefreshLease(testEnv, 'u-1', 'ups-1', 60)).toBe(true)
  })

  it('returns false when no credential row exists', async () => {
    expect(await acquireRefreshLease(testEnv, 'u-1', 'ups-missing', 60)).toBe(false)
    expect(await acquireRefreshLease(testEnv, 'u-missing', 'ups-1', 60)).toBe(false)
  })
})

describe('re-auth flag', () => {
  beforeEach(seedCredentialRow)
  afterEach(cleanup)

  it('starts healthy', async () => {
    const st = await getUserCredentialStatus(testEnv, 'u-1', 'ups-1')
    expect(st).toEqual({ present: true, needsReauth: false })
  })

  it('marks once (clear→set transition) and is then idempotent', async () => {
    expect(await markReauthRequired(testEnv, 'u-1', 'ups-1')).toBe(true)
    // Already flagged → a second mark reports "no transition" so the caller
    // doesn't re-audit every failing session.
    expect(await markReauthRequired(testEnv, 'u-1', 'ups-1')).toBe(false)
    expect((await getUserCredentialStatus(testEnv, 'u-1', 'ups-1')).needsReauth).toBe(true)
  })

  it('clears the flag on a successful save', async () => {
    await markReauthRequired(testEnv, 'u-1', 'ups-1')
    await clearReauthRequired(testEnv, 'u-1', 'ups-1')
    expect((await getUserCredentialStatus(testEnv, 'u-1', 'ups-1')).needsReauth).toBe(false)
    // Re-markable after a clear (a later refresh can fail again).
    expect(await markReauthRequired(testEnv, 'u-1', 'ups-1')).toBe(true)
  })

  it('reports present:false when there is no credential row', async () => {
    expect(await getUserCredentialStatus(testEnv, 'u-1', 'ups-missing')).toEqual({
      present: false,
      needsReauth: false
    })
  })
})
