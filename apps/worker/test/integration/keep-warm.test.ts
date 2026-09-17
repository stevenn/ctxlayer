import { env } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Env as WorkerEnv } from '../../src/env'
import { listKeepWarmDueCredentials } from '../../src/db/queries/upstream-credentials'
import {
  KEEP_WARM_BATCH,
  KEEP_WARM_IDLE_SECONDS,
  KEEP_WARM_RETRY_SECONDS,
  keepWarmUserCredentials,
  type KeepWarmResolver
} from '../../src/upstream/keep-warm'

/**
 * Pins the nightly keep-warm selection + loop (upstream/keep-warm.ts):
 * only long-idle, unflagged, oauth-kind credentials on enabled upstreams
 * are due; the loop resolves each through the injected resolver and never
 * throws. Refresh semantics themselves ride the normal bearer path and
 * are covered by its own tests.
 *
 * Also pins the 2026-09 scheduling fix: the job used to rely on a re-save
 * moving `updated_at` to take a credential out of the due window, but most
 * attempts save nothing (no refresh token / access token still valid), so
 * the same credentials were re-selected every night at the front of an
 * oldest-first batch and reported as "warmed". Scheduling now rides the
 * job's own `keep_warm_after` stamp.
 */

const testEnv = env as unknown as WorkerEnv
const NOW = 1_800_000_000
const STALE = NOW - KEEP_WARM_IDLE_SECONDS - 60
const FRESH = NOW - 3600

async function seedUpstream(id: string, slug: string, enabled = 1): Promise<void> {
  await testEnv.DB.prepare(
    `INSERT INTO upstream_servers
       (id, slug, display_name, transport, url, auth_strategy, auth_config, enabled, created_at, updated_at)
     VALUES (?1, ?2, ?2, 'streamable_http', 'https://x.test/mcp', 'user_oauth', '{}', ?3, 0, 0)`
  )
    .bind(id, slug, enabled)
    .run()
}

async function seedCred(
  userId: string,
  upstreamId: string,
  opts: {
    kind?: string
    updatedAt?: number
    reauthAt?: number | null
    keepWarmAfter?: number | null
  } = {}
): Promise<void> {
  await testEnv.DB.prepare(
    `INSERT INTO user_credentials
       (user_id, upstream_id, kind, ciphertext, iv, key_version, created_at, updated_at,
        reauth_required_at, keep_warm_after)
     VALUES (?1, ?2, ?3, X'00', X'00', 1, 0, ?4, ?5, ?6)`
  )
    .bind(
      userId,
      upstreamId,
      opts.kind ?? 'oauth',
      opts.updatedAt ?? STALE,
      opts.reauthAt ?? null,
      opts.keepWarmAfter ?? null
    )
    .run()
}

const DAY = 86400

/** What a real refresh does: re-save the tokens, which moves `updated_at`. */
async function simulateTokenSave(userId: string, upstreamId: string, at: number): Promise<void> {
  await testEnv.DB.prepare(
    `UPDATE user_credentials SET updated_at = ?3 WHERE user_id = ?1 AND upstream_id = ?2`
  )
    .bind(userId, upstreamId, at)
    .run()
}

/** What a permanent rejection does: bearer.ts sets the reauth flag. */
async function simulateReauthFlag(userId: string, upstreamId: string, at: number): Promise<void> {
  await testEnv.DB.prepare(
    `UPDATE user_credentials SET reauth_required_at = ?3 WHERE user_id = ?1 AND upstream_id = ?2`
  )
    .bind(userId, upstreamId, at)
    .run()
}

async function keepWarmAfterOf(userId: string, upstreamId: string): Promise<number | null> {
  const row = await testEnv.DB.prepare(
    `SELECT keep_warm_after FROM user_credentials WHERE user_id = ?1 AND upstream_id = ?2`
  )
    .bind(userId, upstreamId)
    .first<{ keep_warm_after: number | null }>()
  return row?.keep_warm_after ?? null
}

beforeEach(async () => {
  await testEnv.DB.batch([
    testEnv.DB.prepare('DELETE FROM user_credentials'),
    testEnv.DB.prepare('DELETE FROM upstream_servers'),
    testEnv.DB.prepare('DELETE FROM users'),
    testEnv.DB.prepare(
      `INSERT INTO users (id, email, idp, idp_sub, created_at)
       VALUES ('u-1', 'u1@example.test', 'github', 'gh-1', 0)`
    )
  ])
})

afterEach(async () => {
  await testEnv.DB.batch([
    testEnv.DB.prepare('DELETE FROM user_credentials'),
    testEnv.DB.prepare('DELETE FROM upstream_servers'),
    testEnv.DB.prepare('DELETE FROM users')
  ])
})

describe('listKeepWarmDueCredentials (real D1)', () => {
  it('selects only long-idle, unflagged oauth creds on enabled upstreams', async () => {
    await seedUpstream('up-due', 'up-due')
    await seedUpstream('up-fresh', 'up-fresh')
    await seedUpstream('up-flagged', 'up-flagged')
    await seedUpstream('up-bearer', 'up-bearer')
    await seedUpstream('up-disabled', 'up-disabled', 0)
    await seedCred('u-1', 'up-due')
    await seedCred('u-1', 'up-fresh', { updatedAt: FRESH })
    await seedCred('u-1', 'up-flagged', { reauthAt: NOW - 100 })
    await seedCred('u-1', 'up-bearer', { kind: 'bearer' })
    await seedCred('u-1', 'up-disabled')

    const due = await listKeepWarmDueCredentials(testEnv, NOW, KEEP_WARM_IDLE_SECONDS, 10)
    expect(due.map((d) => d.upstream.slug)).toEqual(['up-due'])
    expect(due[0]!.userId).toBe('u-1')
    // The joined row is a usable upstream row (drives toUpstreamConnection).
    expect(due[0]!.upstream.auth_strategy).toBe('user_oauth')
    expect(due[0]!.upstream.url).toBe('https://x.test/mcp')
  })

  it('never-attempted credentials order oldest-first and respect the limit', async () => {
    await seedUpstream('up-a', 'up-a')
    await seedUpstream('up-b', 'up-b')
    await seedUpstream('up-c', 'up-c')
    await seedCred('u-1', 'up-a', { updatedAt: STALE - 100 })
    await seedCred('u-1', 'up-b', { updatedAt: STALE - 300 })
    await seedCred('u-1', 'up-c', { updatedAt: STALE - 200 })

    const due = await listKeepWarmDueCredentials(testEnv, NOW, KEEP_WARM_IDLE_SECONDS, 2)
    expect(due.map((d) => d.upstream.slug)).toEqual(['up-b', 'up-c'])
  })

  it('skips a credential until its keep_warm_after stamp, however old it is', async () => {
    await seedUpstream('up-waiting', 'up-waiting')
    await seedUpstream('up-ripe', 'up-ripe')
    await seedCred('u-1', 'up-waiting', { updatedAt: STALE - 999, keepWarmAfter: NOW + 1 })
    await seedCred('u-1', 'up-ripe', { updatedAt: STALE, keepWarmAfter: NOW })

    const due = await listKeepWarmDueCredentials(testEnv, NOW, KEEP_WARM_IDLE_SECONDS, 10)
    expect(due.map((d) => d.upstream.slug)).toEqual(['up-ripe'])
  })

  it('queues least-recently-attempted first — age alone no longer wins the front', async () => {
    await seedUpstream('up-old-retried', 'up-old-retried')
    await seedUpstream('up-new-untried', 'up-new-untried')
    await seedUpstream('up-mid-retried', 'up-mid-retried')
    await seedCred('u-1', 'up-old-retried', { updatedAt: STALE - 900, keepWarmAfter: NOW - 10 })
    await seedCred('u-1', 'up-new-untried', { updatedAt: STALE })
    await seedCred('u-1', 'up-mid-retried', { updatedAt: STALE - 500, keepWarmAfter: NOW - 50 })

    const due = await listKeepWarmDueCredentials(testEnv, NOW, KEEP_WARM_IDLE_SECONDS, 10)
    expect(due.map((d) => d.upstream.slug)).toEqual([
      'up-new-untried',
      'up-mid-retried',
      'up-old-retried'
    ])
    // Carries the stamp the loop compares against to detect a real refresh.
    expect(due[0]!.credUpdatedAt).toBe(STALE)
  })
})

describe('keepWarmUserCredentials', () => {
  it('resolves each due credential and tallies outcomes without throwing', async () => {
    await seedUpstream('up-ok', 'up-ok')
    await seedUpstream('up-dead', 'up-dead')
    await seedUpstream('up-boom', 'up-boom')
    await seedCred('u-1', 'up-ok', { updatedAt: STALE - 30 })
    await seedCred('u-1', 'up-dead', { updatedAt: STALE - 20 })
    await seedCred('u-1', 'up-boom', { updatedAt: STALE - 10 })

    const seen: string[] = []
    const r = await keepWarmUserCredentials(testEnv, NOW, async (_env, row) => {
      seen.push(row.slug)
      if (row.slug === 'up-ok') return 'tok'
      if (row.slug === 'up-boom') throw new Error('resolver exploded')
      return null
    })
    expect(seen).toEqual(['up-ok', 'up-dead', 'up-boom'])
    // 'tok' came back but nothing was saved ⇒ idle, NOT a warm. A null with
    // no reauth flag, and a throw, are both transient failures.
    expect(r).toEqual({ due: 3, refreshed: 0, flagged: 0, failed: 2, idle: 1, backlog: 0 })
  })

  it('does nothing when no credential is due', async () => {
    await seedUpstream('up-fresh', 'up-fresh')
    await seedCred('u-1', 'up-fresh', { updatedAt: FRESH })
    const r = await keepWarmUserCredentials(testEnv, NOW, async () => 'tok')
    expect(r).toEqual({ due: 0, refreshed: 0, flagged: 0, failed: 0, idle: 0, backlog: 0 })
  })

  it('tells a real refresh from a no-op, and a detected death from a failure', async () => {
    await seedUpstream('up-refreshed', 'up-refreshed')
    await seedUpstream('up-noop', 'up-noop')
    await seedUpstream('up-died', 'up-died')
    await seedUpstream('up-blip', 'up-blip')
    for (const id of ['up-refreshed', 'up-noop', 'up-died', 'up-blip']) await seedCred('u-1', id)

    const resolver: KeepWarmResolver = async (_env, row, _conn, userId) => {
      if (row.slug === 'up-refreshed') {
        await simulateTokenSave(userId, row.id, NOW)
        return 'new-tok'
      }
      if (row.slug === 'up-noop') return 'still-valid-tok'
      if (row.slug === 'up-died') {
        await simulateReauthFlag(userId, row.id, NOW)
        return null
      }
      return null // up-blip: transient
    }
    const r = await keepWarmUserCredentials(testEnv, NOW, resolver)

    expect(r).toEqual({ due: 4, refreshed: 1, flagged: 1, failed: 1, idle: 1, backlog: 0 })
    // Looked at again a full window later — except the transient failure,
    // which is retried the next night.
    expect(await keepWarmAfterOf('u-1', 'up-refreshed')).toBe(NOW + KEEP_WARM_IDLE_SECONDS)
    expect(await keepWarmAfterOf('u-1', 'up-noop')).toBe(NOW + KEEP_WARM_IDLE_SECONDS)
    expect(await keepWarmAfterOf('u-1', 'up-blip')).toBe(NOW + KEEP_WARM_RETRY_SECONDS)
    expect(KEEP_WARM_RETRY_SECONDS).toBeLessThan(DAY) // or "next night" slips to two
  })

  it('a credential with nothing to refresh is NOT due again the next night', async () => {
    // The prod symptom: tokens with no refresh token / a still-valid access
    // token resolved fine, saved nothing, and came back due every night.
    await seedUpstream('up-github', 'up-github')
    await seedCred('u-1', 'up-github')
    const noop: KeepWarmResolver = async () => 'never-expiring-tok'

    expect((await keepWarmUserCredentials(testEnv, NOW, noop)).due).toBe(1)
    expect((await keepWarmUserCredentials(testEnv, NOW + DAY, noop)).due).toBe(0)
    expect((await keepWarmUserCredentials(testEnv, NOW + 13 * DAY, noop)).due).toBe(0)
    // …and is looked at again once a full idle window has passed.
    expect((await keepWarmUserCredentials(testEnv, NOW + KEEP_WARM_IDLE_SECONDS, noop)).due).toBe(1)
  })

  it('a transient failure is retried the next night', async () => {
    await seedUpstream('up-blip', 'up-blip')
    await seedCred('u-1', 'up-blip')
    const failing: KeepWarmResolver = async () => null

    expect(await keepWarmUserCredentials(testEnv, NOW, failing)).toMatchObject({ due: 1, failed: 1 })
    expect((await keepWarmUserCredentials(testEnv, NOW + DAY, failing)).due).toBe(1)
  })

  it('a full batch of nothing-to-do credentials cannot starve one that needs warming', async () => {
    // KEEP_WARM_BATCH older no-op credentials + one newer refreshable one.
    // Oldest-first with no attempt stamp re-selected the same batch nightly
    // and never reached the last credential.
    await seedUpstream('up-shared', 'up-shared')
    const users = Array.from({ length: KEEP_WARM_BATCH + 1 }, (_, i) => `u-s${i}`)
    await testEnv.DB.batch(
      users.map((u, i) =>
        testEnv.DB.prepare(
          `INSERT INTO users (id, email, idp, idp_sub, created_at) VALUES (?1, ?2, 'github', ?3, 0)`
        ).bind(u, `${u}@example.test`, `gh-${u}-${i}`)
      )
    )
    const needsWarming = users[KEEP_WARM_BATCH]!
    for (const [i, u] of users.entries()) {
      // The refreshable credential is the NEWEST of the stale ones.
      await seedCred(u, 'up-shared', { updatedAt: u === needsWarming ? STALE : STALE - 1000 + i })
    }
    const seen: string[] = []
    const resolver: KeepWarmResolver = async (_env, row, _conn, userId) => {
      seen.push(userId)
      if (userId === needsWarming) await simulateTokenSave(userId, row.id, NOW + DAY)
      return 'tok'
    }

    const night1 = await keepWarmUserCredentials(testEnv, NOW, resolver)
    expect(night1).toMatchObject({ due: KEEP_WARM_BATCH, idle: KEEP_WARM_BATCH, backlog: 1 })
    expect(seen).not.toContain(needsWarming)

    const night2 = await keepWarmUserCredentials(testEnv, NOW + DAY, resolver)
    expect(night2).toMatchObject({ due: 1, refreshed: 1, backlog: 0 })
    expect(seen.at(-1)).toBe(needsWarming)
  })

  it('exports sane un-aggressive knobs (14d idle, bounded batch)', () => {
    expect(KEEP_WARM_IDLE_SECONDS).toBe(14 * 24 * 60 * 60)
    expect(KEEP_WARM_BATCH).toBeLessThanOrEqual(50)
  })
})
