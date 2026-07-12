import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import type { Env } from '../../src/env'
import {
  completeJobDone,
  completeJobError,
  findJobById,
  findLatestJobByKey,
  insertRunningJob,
  listJobsForUser,
  pruneAsyncJobs,
  supersedeRunningJob
} from '../../src/db/queries/async-jobs'

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
