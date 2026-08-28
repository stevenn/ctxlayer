import type { JobRunRow, JobRunStatus } from '@ctxlayer/shared'
import type { Env } from '../../env'
import { newId } from './util'

/**
 * Run ledger for recurring batch jobs (migration 0035). Written by
 * `ops/job-runs.ts:recordJobRun` around every cron task and git-sync run;
 * read by `GET /api/admin/jobs`. Rows are pruned after 90 days by the
 * nightly 'jobs-prune' task.
 */

export interface InsertJobRunInput {
  task: string
  startedAt: number // unix seconds
  durationMs: number
  status: JobRunStatus
  summary: Record<string, unknown> | null
  error: string | null
}

export async function insertJobRun(env: Env, input: InsertJobRunInput): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO job_runs (id, task, started_at, duration_ms, status, summary, error)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
  )
    .bind(
      newId(),
      input.task,
      input.startedAt,
      input.durationMs,
      input.status,
      input.summary ? JSON.stringify(input.summary) : null,
      input.error
    )
    .run()
}

export interface ListJobRunsOpts {
  since: number // unix seconds lower bound
  task?: string
  limit: number
}

export async function listJobRuns(env: Env, opts: ListJobRunsOpts): Promise<JobRunRow[]> {
  const where = ['started_at >= ?1']
  const binds: unknown[] = [opts.since]
  if (opts.task) {
    where.push(`task = ?${binds.length + 1}`)
    binds.push(opts.task)
  }
  const res = await env.DB.prepare(
    `SELECT id, task, started_at, duration_ms, status, summary, error
     FROM job_runs
     WHERE ${where.join(' AND ')}
     ORDER BY started_at DESC
     LIMIT ?${binds.length + 1}`
  )
    .bind(...binds, opts.limit)
    .all<{
      id: string
      task: string
      started_at: number
      duration_ms: number
      status: JobRunStatus
      summary: string | null
      error: string | null
    }>()
  return (res.results ?? []).map((r) => ({
    id: r.id,
    task: r.task,
    startedAt: r.started_at,
    durationMs: r.duration_ms,
    status: r.status,
    summary: r.summary ? safeParseObject(r.summary) : null,
    error: r.error
  }))
}

/** Delete runs older than the cutoff; returns rows removed. */
export async function pruneJobRuns(env: Env, olderThanSec: number): Promise<number> {
  const cutoff = Math.floor(Date.now() / 1000) - olderThanSec
  const res = await env.DB.prepare(`DELETE FROM job_runs WHERE started_at < ?1`)
    .bind(cutoff)
    .run()
  return res.meta.changes ?? 0
}

function safeParseObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}
