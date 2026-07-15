import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import type { Env } from '../../src/env'
import {
  clearAsyncJobResults,
  completeJobDone,
  completeJobError,
  findJobById,
  findLatestJobByKey,
  insertRunningJob,
  listJobsForUser,
  pruneAsyncJobs,
  supersedeRunningJob
} from '../../src/db/queries/async-jobs'
import { asyncJobStats } from '../../src/db/queries/usage-read'

/**
 * Real-D1 cover for the async_jobs query layer (migration 0032). Pins the
 * invariant the submit-dedup relies on: at most one RUNNING job per key
 * (partial UNIQUE index), and completing a job frees the key for a resubmit.
 */
const testEnv = env as unknown as Env

const job = (over: Partial<Parameters<typeof insertRunningJob>[1]> = {}) => ({
  id: 'j1',
  userId: 'u1',
  sessionId: 's1',
  upstreamId: 'ups',
  tool: 'gather_task_context',
  jobKey: 'k1',
  createdAt: 100,
  ...over
})

describe('async-jobs queries', () => {
  it('insert → find by id/key → complete done', async () => {
    await insertRunningJob(testEnv, job())
    expect((await findJobById(testEnv, 'j1'))?.status).toBe('running')
    expect((await findLatestJobByKey(testEnv, 'k1'))?.id).toBe('j1')

    await completeJobDone(testEnv, 'j1', '[{"type":"text","text":"done"}]', 200)
    const done = await findJobById(testEnv, 'j1')
    expect(done?.status).toBe('done')
    expect(done?.result_json).toContain('done')
    expect(done?.completed_at).toBe(200)
  })

  it('partial-unique blocks a second RUNNING job for the same key', async () => {
    await insertRunningJob(testEnv, job({ id: 'a1', jobKey: 'dup' }))
    await expect(insertRunningJob(testEnv, job({ id: 'a2', jobKey: 'dup', createdAt: 101 }))).rejects.toThrow(
      /UNIQUE/i
    )
  })

  it('completing frees the key so a resubmit can take the running slot', async () => {
    await insertRunningJob(testEnv, job({ id: 'b1', jobKey: 'free' }))
    await completeJobError(testEnv, 'b1', 'upstream_timeout', 'timed out', 200)
    // Same key is now insertable again (the done/error row does not hold the slot).
    await insertRunningJob(testEnv, job({ id: 'b2', jobKey: 'free', createdAt: 300 }))
    const latest = await findLatestJobByKey(testEnv, 'free')
    expect(latest?.id).toBe('b2')
    expect(latest?.status).toBe('running')
  })

  it('supersede flips an abandoned running job to error', async () => {
    await insertRunningJob(testEnv, job({ id: 'c1', jobKey: 'sup' }))
    await supersedeRunningJob(testEnv, 'c1', 999)
    const r = await findJobById(testEnv, 'c1')
    expect(r?.status).toBe('error')
    expect(r?.error_code).toBe('superseded')
  })

  it('lists a user’s jobs newest-first and prunes by age', async () => {
    const nowS = Math.floor(Date.now() / 1000)
    await insertRunningJob(testEnv, job({ id: 'd1', userId: 'uX', jobKey: 'p1', createdAt: 20 })) // ancient
    await insertRunningJob(testEnv, job({ id: 'd2', userId: 'uX', jobKey: 'p2', createdAt: nowS })) // fresh

    const jobs = await listJobsForUser(testEnv, 'uX', 10)
    expect(jobs.map((j) => j.id)).toEqual(['d2', 'd1'])

    const removed = await pruneAsyncJobs(testEnv, 3 * 24 * 60 * 60)
    expect(removed).toBeGreaterThanOrEqual(1)
    const survivors = await listJobsForUser(testEnv, 'uX', 10)
    expect(survivors.map((j) => j.id)).toEqual(['d2'])
  })
})

describe('asyncJobStats (admin usage panel)', () => {
  const j = (over: Partial<Parameters<typeof insertRunningJob>[1]>) => ({
    id: 'j',
    userId: 'u1',
    sessionId: '',
    upstreamId: 'ups',
    tool: 't',
    jobKey: 'k',
    createdAt: 0,
    ...over
  })

  it('summarises by status with completed-job durations, newest-first', async () => {
    const now = Math.floor(Date.now() / 1000)
    await insertRunningJob(testEnv, j({ id: 's-done', jobKey: 'sk1', tool: 'gather_task_context', createdAt: now - 200 }))
    await completeJobDone(testEnv, 's-done', '[{"type":"text","text":"ok"}]', now - 80) // 120s run
    await insertRunningJob(testEnv, j({ id: 's-to', jobKey: 'sk2', createdAt: now - 300 }))
    await completeJobError(testEnv, 's-to', 'timeout', 'upstream_timeout: x (ref=1)', now - 150)
    await insertRunningJob(testEnv, j({ id: 's-err', jobKey: 'sk3', createdAt: now - 50 }))
    await completeJobError(testEnv, 's-err', 'upstream_5xx', 'boom', now - 40)
    await insertRunningJob(testEnv, j({ id: 's-run', jobKey: 'sk4', createdAt: now - 10 }))

    const { summary, jobs } = await asyncJobStats(testEnv, { sinceDay: null })
    expect(summary).toMatchObject({
      total: 4,
      done: 1,
      running: 1,
      error: 2,
      timedOut: 1,
      avgDurationMs: 120000,
      maxDurationMs: 120000
    })
    expect(jobs.length).toBe(4)
    expect(jobs[0]?.id).toBe('s-run') // newest first
    expect(jobs[0]?.durationMs).toBeNull() // still running
    expect(jobs.find((x) => x.id === 's-done')?.durationMs).toBe(120000)
  })

  it('scopes by user and upstream', async () => {
    const now = Math.floor(Date.now() / 1000)
    await insertRunningJob(testEnv, j({ id: 'x-a', userId: 'uA', upstreamId: 'up1', jobKey: 'xk1', createdAt: now - 5 }))
    await insertRunningJob(testEnv, j({ id: 'x-b', userId: 'uB', upstreamId: 'up1', jobKey: 'xk2', createdAt: now - 5 }))
    await insertRunningJob(testEnv, j({ id: 'x-c', userId: 'uA', upstreamId: 'up2', jobKey: 'xk3', createdAt: now - 5 }))

    expect((await asyncJobStats(testEnv, { sinceDay: null, userId: 'uA' })).summary.total).toBe(2)
    const scoped = await asyncJobStats(testEnv, { sinceDay: null, userId: 'uA', upstreamId: 'up1' })
    expect(scoped.summary.total).toBe(1)
    expect(scoped.jobs[0]?.id).toBe('x-a')
  })

  it('attributes each job to its caller (joined email; null for a deleted user)', async () => {
    const now = Math.floor(Date.now() / 1000)
    await testEnv.DB.prepare(
      `INSERT INTO users (id, email, idp, idp_sub, created_at)
       VALUES ('uMail', 'jobber@example.test', 'github', 'gh-j', 0)`
    ).run()
    await insertRunningJob(testEnv, j({ id: 'e-known', userId: 'uMail', jobKey: 'ek1', createdAt: now - 5 }))
    await insertRunningJob(testEnv, j({ id: 'e-ghost', userId: 'uGone', jobKey: 'ek2', createdAt: now - 5 }))

    const { jobs } = await asyncJobStats(testEnv, { sinceDay: null })
    expect(jobs.find((x) => x.id === 'e-known')).toMatchObject({
      userId: 'uMail',
      userEmail: 'jobber@example.test'
    })
    // No users row to join → email null, id still surfaced.
    expect(jobs.find((x) => x.id === 'e-ghost')).toMatchObject({ userId: 'uGone', userEmail: null })
  })

  it('clearAsyncJobResults nulls old done blobs but keeps the metadata row', async () => {
    const now = Math.floor(Date.now() / 1000)
    const threeDays = 3 * 24 * 60 * 60
    await insertRunningJob(testEnv, j({ id: 'c-old', jobKey: 'ck1', createdAt: now - threeDays }))
    await completeJobDone(testEnv, 'c-old', '[{"type":"text","text":"big"}]', now - threeDays + 60)
    await insertRunningJob(testEnv, j({ id: 'c-new', jobKey: 'ck2', createdAt: now - 60 }))
    await completeJobDone(testEnv, 'c-new', '[{"type":"text","text":"fresh"}]', now - 10)

    const cleared = await clearAsyncJobResults(testEnv, 24 * 60 * 60) // older than 1 day
    expect(cleared).toBeGreaterThanOrEqual(1)
    const old = await findJobById(testEnv, 'c-old')
    expect(old?.result_json).toBeNull() // blob dropped
    expect(old?.status).toBe('done') // row kept for the 30-day metrics window
    expect((await findJobById(testEnv, 'c-new'))?.result_json).toContain('fresh') // recent kept
  })
})
