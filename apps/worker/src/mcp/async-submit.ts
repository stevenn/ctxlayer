/**
 * The async submit→poll path for slow upstream tools (per-upstream
 * `authConfig.asyncTools`): dedup against `async_jobs`, enqueue a
 * ctxlayer-jobs message, and hand the agent a job token. The queue
 * consumer (`queues/jobs-consumer.ts`) runs the actual call;
 * `poll_task` / `list_tasks` in the session DO read the results.
 * See docs/plan/I-upstream-resilience.md §I9.
 */

import type { Env } from '../env'
import type { UpstreamConnection } from '../db/queries/upstreams'
import {
  findLatestJobByKey,
  insertRunningJob,
  supersedeRunningJob
} from '../db/queries/async-jobs'
import { errMessage } from '../util/errors'
import { safeJson } from './tool-result'

/**
 * TTL for the retry-warm cache: a `done` job younger than this returned
 * directly on an identical re-submit (no re-run). Older → recompute.
 */
const ASYNC_DONE_TTL_S = 15 * 60

/**
 * A `running` job older than this is treated as abandoned (its consumer
 * invocation died) so a resubmit can proceed. Must exceed the hard call
 * ceiling (`UPSTREAM_MAX_CALL_TIMEOUT_MS`, 300s) plus slack.
 */
const STALE_RUNNING_S = 10 * 60

/** Agent-facing surface for an async submit (never an error at submit time). */
export type AsyncSubmitSurface = {
  isError: boolean
  content: Array<{ type: string; text?: string }>
}

export function isAsyncTool(conn: UpstreamConnection, toolName: string): boolean {
  return conn.authConfig.asyncTools?.includes(toolName) ?? false
}

function asyncSurface(text: string): { surface: AsyncSubmitSurface; respJson: string } {
  return { surface: { isError: false, content: [{ type: 'text', text }] }, respJson: text }
}

/** Parse a stored `result_json` content array back into MCP tool content. */
export function parseJobContent(resultJson: string): Array<{ type: string; text?: string }> {
  try {
    const parsed = JSON.parse(resultJson)
    if (Array.isArray(parsed)) return parsed as Array<{ type: string; text?: string }>
  } catch {
    // fall through
  }
  return [{ type: 'text', text: resultJson }]
}

/**
 * Stable dedup key for an async job: same user + upstream + tool + args →
 * same key, so a retried identical call attaches to the in-flight job (or its
 * cached result). SHA-256 hex; `argsJson` is the caller's own serialisation,
 * which is stable across a client's retries of the same call.
 */
export async function hashJobKey(
  userId: string,
  upstreamId: string,
  toolName: string,
  argsJson: string
): Promise<string> {
  const data = new TextEncoder().encode(
    `${userId}\u0000${upstreamId}\u0000${toolName}\u0000${argsJson}`
  )
  const digest = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Async submit for a tool on the upstream's `authConfig.asyncTools`. Dedups
 * against `async_jobs` so a retried identical call attaches to (or reads the
 * cached result of) an in-flight/completed job instead of spawning a
 * duplicate, then enqueues a ctxlayer-jobs message for the background run.
 * Returns the agent-facing surface + the string recorded for usage.
 */
export async function submitAsyncJob(
  env: Env,
  ids: { userId: string; sessionId: string },
  conn: UpstreamConnection,
  upstreamToolName: string,
  args: unknown
): Promise<{ surface: AsyncSubmitSurface; respJson: string }> {
  const argsJson = safeJson(args)
  const jobKey = await hashJobKey(ids.userId, conn.id, upstreamToolName, argsJson)
  const now = Math.floor(Date.now() / 1000)
  const existing = await findLatestJobByKey(env, jobKey)

  if (existing && existing.status === 'running') {
    const age = now - existing.created_at
    if (age <= STALE_RUNNING_S) {
      return asyncSurface(
        `Task already running (job ${existing.id}, ${age}s elapsed). Call poll_task with job_id "${existing.id}" to fetch the result once ready.`
      )
    }
    // The running row's consumer invocation never completed it (age past the
    // hard call ceiling + buffer) — supersede it so a resubmit can take the
    // partial-UNIQUE running slot.
    await supersedeRunningJob(env, existing.id, now)
  } else if (
    existing &&
    existing.status === 'done' &&
    existing.result_json &&
    existing.completed_at != null &&
    now - existing.completed_at <= ASYNC_DONE_TTL_S
  ) {
    // Retry-warm: an identical call was computed recently → return it, no
    // re-run and no polling. Bill the delivery, not the payload — those
    // bytes were already counted under this tool when the consumer ran the
    // job (same rule as poll_task's done-replay branch in session-do.ts).
    return {
      surface: { isError: false, content: parseJobContent(existing.result_json) },
      respJson: `delivered: cached result of job ${existing.id} replayed to the agent (tokens billed when the job ran).`
    }
  }

  const jobId = crypto.randomUUID()
  try {
    await insertRunningJob(env, {
      id: jobId,
      userId: ids.userId,
      sessionId: ids.sessionId,
      upstreamId: conn.id,
      tool: upstreamToolName,
      jobKey,
      createdAt: now
    })
  } catch (err) {
    // Lost the race to a concurrent submit that took the running slot.
    if (/UNIQUE constraint/i.test(errMessage(err))) {
      const running = await findLatestJobByKey(env, jobKey)
      if (running && running.status === 'running') {
        return asyncSurface(
          `Task already running (job ${running.id}). Call poll_task with job_id "${running.id}".`
        )
      }
    }
    throw err
  }
  await env.JOBS_QUEUE.send({
    jobId,
    userId: ids.userId,
    upstreamId: conn.id,
    tool: upstreamToolName,
    argsJson,
    sessionId: ids.sessionId
  })
  return asyncSurface(
    `Task started (job ${jobId}). This tool runs in the background (~2-3 min) because it exceeds interactive client request timeouts. Call poll_task with job_id "${jobId}" to fetch the result, or just re-run this exact call — it returns the cached result once ready.`
  )
}
