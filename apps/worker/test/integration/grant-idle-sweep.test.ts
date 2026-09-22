import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Env as WorkerEnv } from '../../src/env'
import type { OAuthHelpers } from '../../src/oauth/client-grants'
import { sweepIdleGrants } from '../../src/oauth/grant-sweep'
import {
  listGrantActivity,
  stampGrantActivity
} from '../../src/db/queries/oauth-grant-activity'

/**
 * The other half of the sliding session (oauth/grant-sweep.ts): with grants
 * carrying no KV expiration, the nightly sweep is the only thing that ever
 * ends a login. So the properties that matter are the ones that would cause
 * a *surprise* logout — an untracked grant being revoked instead of seeded,
 * a transient KV read failure being read as "these grants are gone" — and
 * they are pinned here against real D1.
 *
 * The OAuth helpers are stubbed: enumerating real grants is
 * `listUserGrants` fanned over users, already covered where it is used
 * (oauth-provider-security.test.ts drives the real provider).
 *
 * The pool gives no per-test D1 rollback, so each test starts from a wiped
 * users + ledger pair (same convention as keep-warm.test.ts).
 */

const testEnv = env as unknown as WorkerEnv
const NOW = 1_800_000_000
const DAY = 86400

beforeEach(async () => {
  await testEnv.DB.batch([
    testEnv.DB.prepare('DELETE FROM oauth_grant_activity'),
    testEnv.DB.prepare('DELETE FROM users')
  ])
})

async function seedUser(id: string): Promise<void> {
  await testEnv.DB.prepare(
    `INSERT INTO users (id, email, idp, idp_sub, created_at)
     VALUES (?1, ?1 || '@test.example', 'github', ?1, 0)`
  )
    .bind(id)
    .run()
}

/** Stub helpers over a fixed grant set; records what got revoked. */
function stubHelpers(
  grantsByUser: Record<string, Array<{ id: string; clientId: string; createdAt: number }>>,
  opts: { failListFor?: string; failRevokeFor?: string } = {}
): { helpers: OAuthHelpers; revoked: string[] } {
  const revoked: string[] = []
  const helpers = {
    listUserGrants: async (userId: string) => {
      if (opts.failListFor === userId) throw new Error('KV read failed')
      return { items: (grantsByUser[userId] ?? []).map((g) => ({ ...g, userId })), cursor: null }
    },
    revokeGrant: async (grantId: string) => {
      if (opts.failRevokeFor === grantId) throw new Error('revoke failed')
      revoked.push(grantId)
    }
  } as unknown as OAuthHelpers
  return { helpers, revoked }
}

describe('nightly idle-grant sweep', () => {
  it('keeps a long-lived login alive as long as it is still refreshing', async () => {
    await seedUser('u1')
    // Authorized 200 days ago — dead under any absolute TTL — but refreshed
    // an hour ago. This is the behaviour the whole change exists for.
    await stampGrantActivity(testEnv, {
      grantId: 'g-live',
      userId: 'u1',
      clientId: 'c1',
      now: NOW - 3600
    })
    const { helpers, revoked } = stubHelpers({
      u1: [{ id: 'g-live', clientId: 'c1', createdAt: NOW - 200 * DAY }]
    })

    const r = await sweepIdleGrants(testEnv, helpers, { idleDays: 90, now: NOW })
    expect(revoked).toEqual([])
    expect(r.revoked).toBe(0)
    expect((await listGrantActivity(testEnv)).map((x) => x.grantId)).toEqual(['g-live'])
  })

  it('revokes a login that stopped refreshing, and drops its row', async () => {
    await seedUser('u1')
    await stampGrantActivity(testEnv, {
      grantId: 'g-quiet',
      userId: 'u1',
      clientId: 'c1',
      now: NOW - 120 * DAY
    })
    const { helpers, revoked } = stubHelpers({
      u1: [{ id: 'g-quiet', clientId: 'c1', createdAt: NOW - 200 * DAY }]
    })

    const r = await sweepIdleGrants(testEnv, helpers, { idleDays: 90, now: NOW })
    expect(revoked).toEqual(['g-quiet'])
    expect(r.revoked).toBe(1)
    expect(await listGrantActivity(testEnv)).toEqual([])
  })

  it('seeds a grant the ledger has never seen instead of revoking it', async () => {
    await seedUser('u1')
    // Pre-ledger grant (or one whose stamps were lost): it must get a full
    // idle window, not a logout on the first night.
    const { helpers, revoked } = stubHelpers({
      u1: [{ id: 'g-legacy', clientId: 'c1', createdAt: NOW - 300 * DAY }]
    })

    const r = await sweepIdleGrants(testEnv, helpers, { idleDays: 90, now: NOW })
    expect(revoked).toEqual([])
    expect(r.seeded).toBe(1)
    const ledger = await listGrantActivity(testEnv)
    expect(ledger).toHaveLength(1)
    expect(ledger[0]?.lastRefreshAt).toBe(NOW)
    expect(ledger[0]?.createdAt).toBe(NOW - 300 * DAY)
  })

  it('changes nothing when a grant read failed (fail-closed)', async () => {
    await seedUser('u1')
    await seedUser('u2')
    await stampGrantActivity(testEnv, {
      grantId: 'g-quiet',
      userId: 'u1',
      clientId: 'c1',
      now: NOW - 120 * DAY
    })
    // u2's grants are unreadable, so u1's quiet grant COULD be a read
    // artifact rather than a real absence. Revoking on that is exactly the
    // silent-logout failure this design removes.
    const { helpers, revoked } = stubHelpers(
      { u1: [{ id: 'g-quiet', clientId: 'c1', createdAt: NOW - 200 * DAY }] },
      { failListFor: 'u2' }
    )

    const r = await sweepIdleGrants(testEnv, helpers, { idleDays: 90, now: NOW })
    expect(r.skippedIncompleteIndex).toBe(true)
    expect(revoked).toEqual([])
    expect(await listGrantActivity(testEnv)).toHaveLength(1)
  })

  it('drops rows whose grant is already gone, without calling them revocations', async () => {
    await seedUser('u1')
    await stampGrantActivity(testEnv, {
      grantId: 'g-vanished',
      userId: 'u1',
      clientId: 'c1',
      now: NOW - DAY
    })
    const { helpers } = stubHelpers({ u1: [] })

    const r = await sweepIdleGrants(testEnv, helpers, { idleDays: 90, now: NOW })
    expect(r.pruned).toBe(1)
    expect(r.revoked).toBe(0)
    expect(await listGrantActivity(testEnv)).toEqual([])
  })

  it('keeps the row when a revoke fails, so the next run retries it', async () => {
    await seedUser('u1')
    await stampGrantActivity(testEnv, {
      grantId: 'g-quiet',
      userId: 'u1',
      clientId: 'c1',
      now: NOW - 120 * DAY
    })
    const { helpers } = stubHelpers(
      { u1: [{ id: 'g-quiet', clientId: 'c1', createdAt: NOW - 200 * DAY }] },
      { failRevokeFor: 'g-quiet' }
    )

    const r = await sweepIdleGrants(testEnv, helpers, { idleDays: 90, now: NOW })
    expect(r.failed).toBe(1)
    expect(r.revoked).toBe(0)
    expect(await listGrantActivity(testEnv)).toHaveLength(1)
  })
})
