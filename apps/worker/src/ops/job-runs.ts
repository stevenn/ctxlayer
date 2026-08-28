import type { JobRunStatus } from '@ctxlayer/shared'
import type { Env } from '../env'
import { insertJobRun } from '../db/queries/job-runs'
import { scrubErrorForStorage } from '../usage/error-detail'
import { errMessage } from '../util/errors'

/**
 * Records one execution of a recurring batch job into the `job_runs`
 * ledger (Admin · Jobs). Wrap the job body:
 *
 *   await recordJobRun(env, 'keep-warm', async () => {
 *     const r = await keepWarmUserCredentials(env, nowSec)
 *     return { status: r.failed > 0 ? 'partial' : 'ok', summary: r }
 *   })
 *
 * Semantics:
 *   - fn's returned outcome sets status/summary (default 'ok'); a THROW
 *     records an error row (message scrubbed) and RE-THROWS, so the
 *     existing per-task catch + ops alert paths stay exactly as they are.
 *   - the ledger is observability, not control: a failed insert is logged
 *     and swallowed — it must never break or retry the job itself.
 */

export interface JobRunOutcome {
  status?: JobRunStatus
  summary?: Record<string, unknown>
  /** Failure detail for non-ok outcomes that did not throw (already scrubbed by caller or plain text). */
  error?: string
}

export async function recordJobRun<T extends JobRunOutcome | undefined | void>(
  env: Env,
  task: string,
  fn: () => Promise<T>
): Promise<T> {
  const startedAt = Math.floor(Date.now() / 1000)
  const t0 = Date.now()
  const write = async (status: JobRunStatus, summary?: Record<string, unknown>, error?: string) => {
    try {
      await insertJobRun(env, {
        task,
        startedAt,
        durationMs: Date.now() - t0,
        status,
        summary: summary ?? null,
        error: error ?? null
      })
    } catch (err) {
      console.error(`[job-runs] ${task}: ledger write failed: ${errMessage(err)}`)
    }
  }
  try {
    const out = await fn()
    const o: JobRunOutcome = out ?? {}
    await write(o.status ?? 'ok', o.summary, o.error)
    return out
  } catch (err) {
    await write('error', undefined, scrubErrorForStorage(errMessage(err)))
    throw err
  }
}
