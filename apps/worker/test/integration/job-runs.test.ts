import { env } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Env as WorkerEnv } from '../../src/env'
import { insertJobRun, listJobRuns, pruneJobRuns } from '../../src/db/queries/job-runs'
import { recordJobRun } from '../../src/ops/job-runs'

/**
 * Pins the job-runs ledger (migration 0035) behind Admin · Jobs: the
 * query filters + ordering, and recordJobRun's contract — outcome maps
 * to a row, a throw records an error row AND re-throws (the per-task
 * alert paths depend on the rethrow).
 */

const testEnv = env as unknown as WorkerEnv
const NOW = 1_800_000_000

async function wipe(): Promise<void> {
  await testEnv.DB.prepare('DELETE FROM job_runs').run()
}

beforeEach(wipe)
afterEach(wipe)

describe('job_runs queries (real D1)', () => {
  it('lists newest-first with task + since filters and the limit', async () => {
    await insertJobRun(testEnv, {
      task: 'keep-warm',
      startedAt: NOW - 100,
      durationMs: 5,
      status: 'ok',
      summary: { warmed: 2 },
      error: null
    })
    await insertJobRun(testEnv, {
      task: 'git-sync',
      startedAt: NOW - 50,
      durationMs: 9,
      status: 'error',
      summary: { source: 'gs-x' },
      error: 'boom'
    })
    await insertJobRun(testEnv, {
      task: 'git-sync',
      startedAt: NOW - 5000,
      durationMs: 9,
      status: 'ok',
      summary: null,
      error: null
    })

    const all = await listJobRuns(testEnv, { since: NOW - 200, limit: 10 })
    expect(all.map((r) => r.task)).toEqual(['git-sync', 'keep-warm'])
    expect(all[0]!.summary).toEqual({ source: 'gs-x' })
    expect(all[0]!.error).toBe('boom')

    const gitOnly = await listJobRuns(testEnv, { since: 0, task: 'git-sync', limit: 10 })
    expect(gitOnly).toHaveLength(2)

    const capped = await listJobRuns(testEnv, { since: 0, limit: 1 })
    expect(capped).toHaveLength(1)
  })

  it('prunes rows older than the cutoff', async () => {
    const now = Math.floor(Date.now() / 1000)
    await insertJobRun(testEnv, {
      task: 'old',
      startedAt: now - 100 * 86400,
      durationMs: 1,
      status: 'ok',
      summary: null,
      error: null
    })
    await insertJobRun(testEnv, {
      task: 'fresh',
      startedAt: now - 3600,
      durationMs: 1,
      status: 'ok',
      summary: null,
      error: null
    })
    const removed = await pruneJobRuns(testEnv, 90 * 86400)
    expect(removed).toBe(1)
    const rest = await listJobRuns(testEnv, { since: 0, limit: 10 })
    expect(rest.map((r) => r.task)).toEqual(['fresh'])
  })
})

describe('recordJobRun', () => {
  it('records the returned outcome (status + summary)', async () => {
    await recordJobRun(testEnv, 'keep-warm', async () => ({
      status: 'partial' as const,
      summary: { due: 3, warmed: 2, failed: 1 }
    }))
    const [row] = await listJobRuns(testEnv, { since: 0, limit: 5 })
    expect(row!.task).toBe('keep-warm')
    expect(row!.status).toBe('partial')
    expect(row!.summary).toEqual({ due: 3, warmed: 2, failed: 1 })
    expect(row!.error).toBeNull()
  })

  it('defaults a void return to an ok row', async () => {
    await recordJobRun(testEnv, 'usage-prune', async () => {})
    const [row] = await listJobRuns(testEnv, { since: 0, limit: 5 })
    expect(row!.status).toBe('ok')
    expect(row!.summary).toBeNull()
  })

  it('a throw records an error row and RE-THROWS for the alert path', async () => {
    await expect(
      recordJobRun(testEnv, 'oauth-client-prune', async () => {
        throw new Error('kv exploded')
      })
    ).rejects.toThrow('kv exploded')
    const [row] = await listJobRuns(testEnv, { since: 0, limit: 5 })
    expect(row!.task).toBe('oauth-client-prune')
    expect(row!.status).toBe('error')
    expect(row!.error).toContain('kv exploded')
  })
})
