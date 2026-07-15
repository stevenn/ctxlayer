import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import { pruneUsageEvents, writeUsageEvent } from '../../src/db/queries/usage'
import { recentErrors } from '../../src/db/queries/usage-read'
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
