/**
 * D1 access for the async submit→poll job table (`async_jobs`, migration
 * 0032). Keeps route/tool handlers SQL-free per the repo convention.
 *
 * Lifecycle of one job:
 *   1. proxy submit (`tools-proxy.ts submitAsyncJob`) inserts a `running` row
 *      and enqueues a ctxlayer-jobs message;
 *   2. the queue consumer (`queues/jobs-consumer.ts`) runs the real upstream
 *      call, then flips the row to `done` (with `result_json`) or `error`;
 *   3. the `poll_task` / `list_tasks` built-ins read it back for the caller.
 *
 * At most one `running` row exists per `job_key` (partial UNIQUE index), so a
 * retried identical submit attaches to the in-flight job rather than spawning
 * a duplicate.
 */

import type { Env } from '../../env'

export type AsyncJobStatus = 'running' | 'done' | 'error'

export interface AsyncJobRow {
  id: string
  user_id: string
  session_id: string
  upstream_id: string
  tool: string
  job_key: string
  status: AsyncJobStatus
  result_json: string | null
  error_code: string | null
  error_detail: string | null
  created_at: number
  completed_at: number | null
}

const COLS = `id, user_id, session_id, upstream_id, tool, job_key, status,
              result_json, error_code, error_detail, created_at, completed_at`

/** Most recent job (any status) for a dedup key — drives submit dedup. */
export async function findLatestJobByKey(env: Env, jobKey: string): Promise<AsyncJobRow | null> {
  const row = await env.DB.prepare(
    `SELECT ${COLS} FROM async_jobs WHERE job_key = ?1 ORDER BY created_at DESC LIMIT 1`
  )
    .bind(jobKey)
    .first<AsyncJobRow>()
  return row ?? null
}

export async function findJobById(env: Env, id: string): Promise<AsyncJobRow | null> {
  const row = await env.DB.prepare(`SELECT ${COLS} FROM async_jobs WHERE id = ?1`)
    .bind(id)
    .first<AsyncJobRow>()
  return row ?? null
}

export interface InsertJobInput {
  id: string
  userId: string
  sessionId: string
  upstreamId: string
  tool: string
  jobKey: string
  createdAt: number
}

/**
 * Insert a fresh `running` job. Throws on the partial-UNIQUE conflict when a
 * running job already holds this key (a concurrent submit won the race) — the
 * caller catches that and re-reads to attach.
 */
export async function insertRunningJob(env: Env, j: InsertJobInput): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO async_jobs (id, user_id, session_id, upstream_id, tool, job_key, status, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'running', ?7)`
  )
    .bind(j.id, j.userId, j.sessionId, j.upstreamId, j.tool, j.jobKey, j.createdAt)
    .run()
}

export async function completeJobDone(
  env: Env,
  id: string,
  resultJson: string,
  completedAt: number
): Promise<void> {
  await env.DB.prepare(
    `UPDATE async_jobs SET status = 'done', result_json = ?2, completed_at = ?3
     WHERE id = ?1 AND status = 'running'`
  )
    .bind(id, resultJson, completedAt)
    .run()
}

export async function completeJobError(
  env: Env,
  id: string,
  errorCode: string,
  errorDetail: string,
  completedAt: number
): Promise<void> {
  await env.DB.prepare(
    `UPDATE async_jobs SET status = 'error', error_code = ?2, error_detail = ?3, completed_at = ?4
     WHERE id = ?1 AND status = 'running'`
  )
    .bind(id, errorCode, errorDetail, completedAt)
    .run()
}

/**
 * Flip an abandoned `running` job (its consumer invocation died without
 * completing it) to `error`, freeing the partial-UNIQUE running slot so a
 * resubmit of the same key can take it.
 */
export async function supersedeRunningJob(env: Env, id: string, at: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE async_jobs SET status = 'error', error_code = 'superseded',
       error_detail = 'Job abandoned before completion; resubmitted.', completed_at = ?2
     WHERE id = ?1 AND status = 'running'`
  )
    .bind(id, at)
    .run()
}

export async function listJobsForUser(env: Env, userId: string, limit = 20): Promise<AsyncJobRow[]> {
  const res = await env.DB.prepare(
    `SELECT ${COLS} FROM async_jobs WHERE user_id = ?1 ORDER BY created_at DESC LIMIT ?2`
  )
    .bind(userId, limit)
    .all<AsyncJobRow>()
  return res.results ?? []
}

/**
 * Null the (potentially large) `result_json` blob on done jobs older than the
 * cutoff. The retry-warm cache is 15 min and polling is a live-workflow action,
 * so the body is dead weight after a day — but the lightweight row (status,
 * tool, timings, error_code) is kept for the 30-day usage-metrics window.
 * Returns rows cleared.
 */
export async function clearAsyncJobResults(env: Env, olderThanSeconds: number): Promise<number> {
  const cutoff = Math.floor(Date.now() / 1000) - olderThanSeconds
  const res = await env.DB.prepare(
    `UPDATE async_jobs SET result_json = NULL
     WHERE status = 'done' AND result_json IS NOT NULL
       AND completed_at IS NOT NULL AND completed_at < ?1`
  )
    .bind(cutoff)
    .run()
  return res.meta.changes ?? 0
}

/** Nightly prune — drop jobs older than the retention window. Returns rows removed. */
export async function pruneAsyncJobs(env: Env, olderThanSeconds: number): Promise<number> {
  const cutoff = Math.floor(Date.now() / 1000) - olderThanSeconds
  const res = await env.DB.prepare(`DELETE FROM async_jobs WHERE created_at < ?1`).bind(cutoff).run()
  return res.meta.changes ?? 0
}
