import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Env as WorkerEnv } from '../../src/env'
import {
  listGrantLifetimes,
  recordGrantDeath
} from '../../src/db/queries/grant-observations'
import { getUpstreamById } from '../../src/db/queries/upstreams'
import { upsertUserCredential, getUserCredentialStatus } from '../../src/db/queries/upstream-credentials'

/**
 * The measured source of the expiry countdown (migration 0039): deaths are
 * recorded where they happen and folded into a per-upstream median, and the
 * provider-reported source is persisted per credential.
 *
 * No per-test rollback in this pool, so each test wipes what it seeds.
 */

const testEnv = env as unknown as WorkerEnv
const NOW = 1_800_000_000
const DAY = 86400

beforeEach(async () => {
  await testEnv.DB.batch([
    testEnv.DB.prepare('DELETE FROM upstream_grant_observations'),
    testEnv.DB.prepare('DELETE FROM user_credentials'),
    testEnv.DB.prepare('DELETE FROM upstream_servers'),
    testEnv.DB.prepare('DELETE FROM users'),
    testEnv.DB.prepare(
      `INSERT INTO users (id, email, idp, idp_sub, created_at)
       VALUES ('u-1', 'u1@example.test', 'github', 'gh-1', 0)`
    ),
    testEnv.DB.prepare(
      `INSERT INTO upstream_servers
         (id, slug, display_name, transport, url, auth_strategy, auth_config, created_at, updated_at)
       VALUES ('ups-1', 'up-x', 'Up X', 'streamable_http', 'https://x.test/mcp', 'user_oauth', '{}', 0, 0)`
    )
  ])
})

const die = (lifetimeDays: number, userId = 'u-1') =>
  recordGrantDeath(testEnv, {
    upstreamId: 'ups-1',
    userId,
    grantedAt: NOW - lifetimeDays * DAY,
    diedAt: NOW
  })

describe('grant lifetime observations', () => {
  it('keeps the estimate null until enough deaths have been seen', async () => {
    expect(await die(14.2)).toBeNull()
    expect(await die(14.5)).toBeNull()
    expect((await getUpstreamById(testEnv, 'ups-1'))?.observed_grant_days).toBeNull()
  })

  it('folds deaths into the median and denormalises it onto the upstream', async () => {
    await die(14.2)
    await die(14.5, 'u-1')
    const days = await die(14.8)
    expect(days).toBe(14)
    expect((await getUpstreamById(testEnv, 'ups-1'))?.observed_grant_days).toBe(14)
    expect(await listGrantLifetimes(testEnv, 'ups-1')).toHaveLength(3)
  })

  it('ignores a non-positive lifetime instead of recording a clock artifact', async () => {
    expect(
      await recordGrantDeath(testEnv, {
        upstreamId: 'ups-1',
        userId: 'u-1',
        grantedAt: NOW,
        diedAt: NOW
      })
    ).toBeNull()
    expect(await listGrantLifetimes(testEnv, 'ups-1')).toHaveLength(0)
  })

  it('survives one hand-disconnect outlier without dragging the estimate down', async () => {
    await die(0.1)
    await die(14.2)
    await die(14.4)
    await die(14.6)
    expect((await getUpstreamById(testEnv, 'ups-1'))?.observed_grant_days).toBe(14)
  })
})

describe('provider-reported expiry on the credential', () => {
  const save = (authExpiresAt: number | null, newGrant = false) =>
    upsertUserCredential(testEnv, 'u-1', 'ups-1', {
      kind: 'oauth',
      ciphertext: new Uint8Array([1]),
      iv: new Uint8Array([2]),
      keyVersion: 1,
      newGrant,
      authExpiresAt
    })

  it('persists what the provider reported', async () => {
    await save(NOW + 30 * DAY, true)
    expect((await getUserCredentialStatus(testEnv, 'u-1', 'ups-1')).authExpiresAt).toBe(
      NOW + 30 * DAY
    )
  })

  it('keeps a reported deadline when a later refresh says nothing about it', async () => {
    // "Absent" is not "no expiry" — an absolute deadline reported once still
    // stands, and most refresh responses repeat nothing.
    await save(NOW + 30 * DAY, true)
    await save(null)
    expect((await getUserCredentialStatus(testEnv, 'u-1', 'ups-1')).authExpiresAt).toBe(
      NOW + 30 * DAY
    )
  })

  it('narrows to the newest value the provider reports', async () => {
    await save(NOW + 30 * DAY, true)
    await save(NOW + 20 * DAY)
    expect((await getUserCredentialStatus(testEnv, 'u-1', 'ups-1')).authExpiresAt).toBe(
      NOW + 20 * DAY
    )
  })

  it('clears it on a NEW authorization that reports nothing', async () => {
    // The old deadline belonged to the grant that was just replaced; carrying
    // it over would warn about an authorization that no longer exists.
    await save(NOW + 30 * DAY, true)
    await save(null, true)
    expect((await getUserCredentialStatus(testEnv, 'u-1', 'ups-1')).authExpiresAt).toBeNull()
  })
})
