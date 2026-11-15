import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { pruneUsageEvents, writeUsageEvent } from '../../src/db/queries/usage'
import { laneStats, recentErrors } from '../../src/db/queries/usage-read'
import type { UsageEventMsg } from '../../src/usage/event'
import type { Env as WorkerEnv } from '../../src/env'

/**
 * Integration coverage for the M6 usage pipeline write path. Verifies
 * the NULL → '' translation that lets the rollup PK stay NOT NULL, the
 * UPSERT aggregation, the error-count branch, and the retention prune.
 */

const SECONDS_PER_DAY = 86400
const NOW = 1_780_000_000 // 2026-05-29-ish; stable across runs

function event(overrides: Partial<UsageEventMsg> = {}): UsageEventMsg {
  return {
    id: crypto.randomUUID().replace(/-/g, ''),
    ts: NOW,
    userId: 'u-alice',
    sessionId: 's-abc',
    upstreamId: null,
    tool: 'whoami',
    reqBytes: 4,
    respBytes: 12,
    reqTokens: 2,
    respTokens: 5,
    latencyMs: 7,
    status: 'ok',
    truncated: false,
    ...overrides
  }
}

const testEnv = env as unknown as WorkerEnv

beforeEach(async () => {
  // Per-test isolation rolls back at end-of-test, but inside one test
  // we want a clean slate too. The migration creates empty tables, so
  // just deleting any stragglers from setup phases is cheap insurance.
  await testEnv.DB.batch([
    testEnv.DB.prepare('DELETE FROM usage_events'),
    testEnv.DB.prepare('DELETE FROM usage_rollups_daily')
  ])
})

describe('writeUsageEvent', () => {
  it('keeps NULL upstream_id on the raw row and translates to "" on the rollup', async () => {
    await writeUsageEvent(testEnv, event())

    const raw = await testEnv.DB.prepare('SELECT upstream_id FROM usage_events').first<{
      upstream_id: string | null
    }>()
    expect(raw?.upstream_id).toBeNull()

    const rollup = await testEnv.DB.prepare(
      'SELECT upstream_id, calls FROM usage_rollups_daily'
    ).first<{ upstream_id: string; calls: number }>()
    expect(rollup?.upstream_id).toBe('')
    expect(rollup?.calls).toBe(1)
  })

  it('aggregates two same-key events into one rollup row', async () => {
    await writeUsageEvent(testEnv, event({ reqTokens: 3, respTokens: 7 }))
    await writeUsageEvent(testEnv, event({ reqTokens: 5, respTokens: 11 }))

    const r = await testEnv.DB.prepare(
      `SELECT calls, req_tokens, resp_tokens, errors
       FROM usage_rollups_daily`
    ).first<{
      calls: number
      req_tokens: number
      resp_tokens: number
      errors: number
    }>()
    expect(r).toEqual({ calls: 2, req_tokens: 8, resp_tokens: 18, errors: 0 })
  })

  it('counts error + timeout statuses in the rollup errors column', async () => {
    await writeUsageEvent(testEnv, event({ status: 'ok' }))
    await writeUsageEvent(testEnv, event({ status: 'error' }))
    await writeUsageEvent(testEnv, event({ status: 'timeout' }))

    const r = await testEnv.DB.prepare('SELECT calls, errors FROM usage_rollups_daily').first<{
      calls: number
      errors: number
    }>()
    expect(r).toEqual({ calls: 3, errors: 2 })
  })

  it('splits rollups across (day, user_id, upstream_id, tool)', async () => {
    // Same user, different tools → two rollup rows.
    await writeUsageEvent(testEnv, event({ tool: 'whoami' }))
    await writeUsageEvent(testEnv, event({ tool: 'search_docs' }))

    const rows = await testEnv.DB.prepare(
      'SELECT tool, calls FROM usage_rollups_daily ORDER BY tool'
    ).all<{ tool: string; calls: number }>()
    expect(rows.results).toHaveLength(2)
    expect(rows.results.map((r) => r.tool)).toEqual(['search_docs', 'whoami'])
  })

  it('uses the proxied upstream id verbatim on the rollup', async () => {
    await writeUsageEvent(testEnv, event({ upstreamId: 'ups-notion', tool: 'notion__search' }))

    const r = await testEnv.DB.prepare('SELECT upstream_id, tool FROM usage_rollups_daily').first<{
      upstream_id: string
      tool: string
    }>()
    expect(r).toEqual({ upstream_id: 'ups-notion', tool: 'notion__search' })
  })
})

describe('recentErrors', () => {
  const dayAgo = Math.floor(Date.now() / 1000) - SECONDS_PER_DAY

  it('returns only failures, newest first, with code + scrubbed message', async () => {
    await writeUsageEvent(testEnv, event({ ts: dayAgo - 10, status: 'ok' }))
    await writeUsageEvent(
      testEnv,
      event({
        ts: dayAgo,
        status: 'error',
        upstreamId: 'ups-notion',
        tool: 'notion__search',
        errorCode: 'upstream_5xx',
        errorMessage: '500 internal server error'
      })
    )
    await writeUsageEvent(
      testEnv,
      event({
        ts: dayAgo - 5,
        status: 'timeout',
        tool: 'whoami',
        errorCode: 'local_error',
        errorMessage: 'deadline exceeded'
      })
    )

    const rows = await recentErrors(testEnv, { sinceDay: null, userId: 'u-alice' })
    expect(rows).toHaveLength(2)
    // Newest first: the 5xx (dayAgo) before the timeout (dayAgo - 5).
    expect(rows[0]).toMatchObject({
      tool: 'notion__search',
      upstreamId: 'ups-notion',
      code: 'upstream_5xx',
      message: '500 internal server error'
    })
    // Built-in failure → upstreamId normalised to '' (NULL on the raw row).
    expect(rows[1]).toMatchObject({ tool: 'whoami', upstreamId: '', code: 'local_error' })
  })

  it('scopes to the requesting user', async () => {
    await writeUsageEvent(testEnv, event({ ts: dayAgo, status: 'error', userId: 'u-alice' }))
    await writeUsageEvent(testEnv, event({ ts: dayAgo, status: 'error', userId: 'u-bob' }))

    const alice = await recentErrors(testEnv, { sinceDay: null, userId: 'u-alice' })
    expect(alice).toHaveLength(1)
  })

  it('attributes each failure to its caller (joined email; null for a deleted user)', async () => {
    await testEnv.DB.prepare(
      `INSERT INTO users (id, email, idp, idp_sub, created_at)
       VALUES ('u-alice', 'alice@example.test', 'github', 'gh-a', 0)`
    ).run()
    await writeUsageEvent(testEnv, event({ ts: dayAgo, status: 'error', userId: 'u-alice' }))
    await writeUsageEvent(testEnv, event({ ts: dayAgo - 1, status: 'error', userId: 'u-ghost' }))

    // Org-wide (no userId scope) → the admin drill-down surfaces both callers.
    const rows = await recentErrors(testEnv, { sinceDay: null })
    expect(rows.find((r) => r.userId === 'u-alice')?.userEmail).toBe('alice@example.test')
    expect(rows.find((r) => r.userId === 'u-ghost')?.userEmail).toBeNull()
  })

  it('clamps the lower bound to the 30-day raw-retention floor', async () => {
    const old = Math.floor(Date.now() / 1000) - 40 * SECONDS_PER_DAY
    await writeUsageEvent(testEnv, event({ ts: old, status: 'error' }))

    // Even the unbounded "all" range can't surface a 40-day-old error.
    const rows = await recentErrors(testEnv, { sinceDay: null, userId: 'u-alice' })
    expect(rows).toHaveLength(0)
  })

  it('synthesises a code for rows written before the error-detail columns', async () => {
    // Simulate a pre-0029 error row: status set, but no code/message.
    await writeUsageEvent(
      testEnv,
      event({ ts: dayAgo, status: 'error', upstreamId: 'ups-x', tool: 'x__y' })
    )
    const rows = await recentErrors(testEnv, { sinceDay: null, userId: 'u-alice' })
    expect(rows[0]).toMatchObject({ code: 'upstream_error', message: null })
  })
})

describe('pruneUsageEvents', () => {
  it('deletes raw rows older than the window but leaves rollups untouched', async () => {
    const oldTs = Math.floor(Date.now() / 1000) - 40 * SECONDS_PER_DAY
    const freshTs = Math.floor(Date.now() / 1000) - 1 * SECONDS_PER_DAY

    await writeUsageEvent(testEnv, event({ ts: oldTs }))
    await writeUsageEvent(testEnv, event({ ts: freshTs }))

    const removed = await pruneUsageEvents(testEnv, 30)
    expect(removed).toBe(1)

    const rawCount = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM usage_events').first<{
      n: number
    }>()
    expect(rawCount?.n).toBe(1)

    // Rollups stay forever — confirms we only pruned raw events.
    const rollupCount = await testEnv.DB.prepare(
      'SELECT COUNT(*) AS n FROM usage_rollups_daily'
    ).first<{ n: number }>()
    expect(rollupCount?.n).toBe(2)
  })
})

describe('protocol lanes', () => {
  // laneStats clamps to the 30-day raw-retention floor measured from the
  // real clock, so these events are stamped relative to now.
  const now = Math.floor(Date.now() / 1000)
  const scope = { sinceDay: null }

  it('writes lane, protocol revision and client name onto the raw row', async () => {
    await writeUsageEvent(
      testEnv,
      event({ lane: 'stateless', protocolVersion: '2026-07-28', clientName: 'claude-ai' })
    )
    const row = await testEnv.DB.prepare(
      'SELECT lane, protocol_version, client_name FROM usage_events'
    ).first()
    expect(row).toEqual({
      lane: 'stateless',
      protocol_version: '2026-07-28',
      client_name: 'claude-ai'
    })
  })

  it('a message from before lane tracking still writes, with a null lane', async () => {
    await writeUsageEvent(testEnv, event())
    const row = await testEnv.DB.prepare('SELECT lane FROM usage_events').first<{
      lane: string | null
    }>()
    expect(row?.lane).toBeNull()
  })

  it('refuses a lane the schema does not know', async () => {
    await expect(
      writeUsageEvent(testEnv, event({ lane: 'bogus' as never }))
    ).rejects.toThrow()
  })

  it('aggregates calls, errors, users, latency percentiles and clients per lane', async () => {
    const session = (over: Partial<UsageEventMsg>) =>
      event({ ts: now, lane: 'session', protocolVersion: '2025-11-25', ...over })
    // Session lane: latencies 10..100 ms across two users and two clients.
    for (let i = 1; i <= 10; i++) {
      await writeUsageEvent(
        testEnv,
        session({
          latencyMs: i * 10,
          userId: i <= 7 ? 'u-alice' : 'u-bob',
          clientName: i <= 7 ? 'claude-code' : 'cursor',
          status: i === 10 ? 'timeout' : i === 9 ? 'error' : 'ok'
        })
      )
    }
    await writeUsageEvent(
      testEnv,
      event({
        ts: now,
        lane: 'stateless',
        protocolVersion: '2026-07-28',
        clientName: 'claude-ai',
        latencyMs: 55
      })
    )
    await writeUsageEvent(testEnv, event({ ts: now, latencyMs: 5 })) // pre-tracking row

    const lanes = await laneStats(testEnv, scope)
    expect(lanes.map((l) => l.lane)).toEqual(['session', 'stateless', null]) // most calls first

    const s = lanes[0]
    expect(s).toMatchObject({
      calls: 10,
      errors: 2,
      timeouts: 1,
      users: 2,
      p50LatencyMs: 50,
      p95LatencyMs: 100,
      lastSeen: now,
      protocolVersions: ['2025-11-25']
    })
    expect(s?.clients).toEqual([
      { clientName: 'claude-code', calls: 7, users: 1, lastSeen: now },
      { clientName: 'cursor', calls: 3, users: 1, lastSeen: now }
    ])

    expect(lanes[1]).toMatchObject({ lane: 'stateless', calls: 1, p50LatencyMs: 55, p95LatencyMs: 55 })
    expect(lanes[1]?.clients[0]?.clientName).toBe('claude-ai')
    expect(lanes[2]).toMatchObject({ lane: null, calls: 1, protocolVersions: [] })
  })

  it('honours the user scope and the 30-day retention floor', async () => {
    await writeUsageEvent(testEnv, event({ ts: now, lane: 'session', userId: 'u-alice' }))
    await writeUsageEvent(testEnv, event({ ts: now, lane: 'stateless', userId: 'u-bob' }))
    await writeUsageEvent(
      testEnv,
      event({ ts: now - 31 * SECONDS_PER_DAY, lane: 'stateless', userId: 'u-alice' })
    )
    const lanes = await laneStats(testEnv, { sinceDay: null, userId: 'u-alice' })
    expect(lanes).toHaveLength(1)
    expect(lanes[0]).toMatchObject({ lane: 'session', calls: 1 })
  })

  it('carries the lane and client onto the errors drill-down', async () => {
    await writeUsageEvent(
      testEnv,
      event({
        ts: now,
        status: 'error',
        errorCode: 'local_error',
        lane: 'stateless',
        clientName: 'claude-ai'
      })
    )
    const [err] = await recentErrors(testEnv, scope)
    expect(err).toMatchObject({ lane: 'stateless', clientName: 'claude-ai' })
  })
})
