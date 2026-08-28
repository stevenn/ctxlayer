import { env } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Env as WorkerEnv } from '../../src/env'
import { listKeepWarmDueCredentials } from '../../src/db/queries/upstream-credentials'
import {
  KEEP_WARM_BATCH,
  KEEP_WARM_IDLE_SECONDS,
  keepWarmUserCredentials
} from '../../src/upstream/keep-warm'

/**
 * Pins the nightly keep-warm selection + loop (upstream/keep-warm.ts):
 * only long-idle, unflagged, oauth-kind credentials on enabled upstreams
 * are due; the loop resolves each through the injected resolver and never
 * throws. Refresh semantics themselves ride the normal bearer path and
 * are covered by its own tests.
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
  opts: { kind?: string; updatedAt?: number; reauthAt?: number | null } = {}
): Promise<void> {
  await testEnv.DB.prepare(
    `INSERT INTO user_credentials
       (user_id, upstream_id, kind, ciphertext, iv, key_version, created_at, updated_at, reauth_required_at)
     VALUES (?1, ?2, ?3, X'00', X'00', 1, 0, ?4, ?5)`
  )
    .bind(userId, upstreamId, opts.kind ?? 'oauth', opts.updatedAt ?? STALE, opts.reauthAt ?? null)
    .run()
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

  it('orders oldest-first and respects the limit', async () => {
    await seedUpstream('up-a', 'up-a')
    await seedUpstream('up-b', 'up-b')
    await seedUpstream('up-c', 'up-c')
    await seedCred('u-1', 'up-a', { updatedAt: STALE - 100 })
    await seedCred('u-1', 'up-b', { updatedAt: STALE - 300 })
    await seedCred('u-1', 'up-c', { updatedAt: STALE - 200 })

    const due = await listKeepWarmDueCredentials(testEnv, NOW, KEEP_WARM_IDLE_SECONDS, 2)
    expect(due.map((d) => d.upstream.slug)).toEqual(['up-b', 'up-c'])
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
    expect(r).toEqual({ due: 3, warmed: 1, failed: 2 })
  })

  it('does nothing when no credential is due', async () => {
    await seedUpstream('up-fresh', 'up-fresh')
    await seedCred('u-1', 'up-fresh', { updatedAt: FRESH })
    const r = await keepWarmUserCredentials(testEnv, NOW, async () => 'tok')
    expect(r).toEqual({ due: 0, warmed: 0, failed: 0 })
  })

  it('exports sane un-aggressive knobs (14d idle, bounded batch)', () => {
    expect(KEEP_WARM_IDLE_SECONDS).toBe(14 * 24 * 60 * 60)
    expect(KEEP_WARM_BATCH).toBeLessThanOrEqual(50)
  })
})
