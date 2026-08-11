import { env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Env as WorkerEnv } from '../../src/env'
import type { UpstreamConnection } from '../../src/db/queries/upstreams'
import { completeJobDone, insertRunningJob } from '../../src/db/queries/async-jobs'
import { hashJobKey, submitAsyncJob } from '../../src/mcp/async-submit'

/**
 * Real-D1 cover for `submitAsyncJob`'s dedup branches. Pins the
 * usage-accounting rule from the 2026-08 review: a retry-warm cache hit
 * bills a small delivery marker, NOT the full cached payload — those
 * bytes were already counted when the consumer ran the job (same rule
 * as poll_task's done-replay, commit 9c3dc35).
 */

const testEnv = env as unknown as WorkerEnv

const conn = { id: 'ups-1', slug: 'up-slow', authConfig: {} } as unknown as UpstreamConnection
const ids = { userId: 'u-1', sessionId: 's-1' }
const ARGS = { q: 'x' }

async function seedDoneJob(resultJson: string): Promise<string> {
  const argsJson = JSON.stringify(ARGS)
  const jobKey = await hashJobKey(ids.userId, conn.id, 'gather', argsJson)
  const now = Math.floor(Date.now() / 1000)
  await insertRunningJob(testEnv, {
    id: 'job-1',
    userId: ids.userId,
    sessionId: ids.sessionId,
    upstreamId: conn.id,
    tool: 'gather',
    jobKey,
    createdAt: now - 30
  })
  await completeJobDone(testEnv, 'job-1', resultJson, now - 10)
  return jobKey
}

beforeEach(async () => {
  await testEnv.DB.prepare('DELETE FROM async_jobs').run()
})

describe('submitAsyncJob (real D1)', () => {
  it('retry-warm hit returns the cached payload but bills only a delivery marker', async () => {
    const payload = JSON.stringify([{ type: 'text', text: 'BIG-RESULT '.repeat(100) }])
    await seedDoneJob(payload)

    const sub = await submitAsyncJob(testEnv, ids, conn, 'gather', ARGS)
    // The agent gets the real cached result…
    expect(sub.surface.isError).toBe(false)
    expect(sub.surface.content[0]?.text).toContain('BIG-RESULT')
    // …but usage records a small marker, not the payload (no double count).
    expect(sub.respJson).not.toContain('BIG-RESULT')
    expect(sub.respJson).toContain('job-1')
    expect(sub.respJson).toContain('delivered')
  })

  it('attaches to a fresh running job instead of resubmitting', async () => {
    const argsJson = JSON.stringify(ARGS)
    const jobKey = await hashJobKey(ids.userId, conn.id, 'gather', argsJson)
    await insertRunningJob(testEnv, {
      id: 'job-run',
      userId: ids.userId,
      sessionId: ids.sessionId,
      upstreamId: conn.id,
      tool: 'gather',
      jobKey,
      createdAt: Math.floor(Date.now() / 1000) - 5
    })
    const sub = await submitAsyncJob(testEnv, ids, conn, 'gather', ARGS)
    expect(sub.surface.content[0]?.text).toContain('already running (job job-run')
    expect(sub.respJson).toContain('job-run')
  })
})
