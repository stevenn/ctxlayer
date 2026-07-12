import { z } from 'zod'
import type { Env } from '../env'
import {
  getUpstreamById,
  toUpstreamConnection,
  type UpstreamConnection
} from '../db/queries/upstreams'
import { resolveUserUpstreamBearer } from '../upstream/bearer'
import { createUpstreamClient } from '../upstream/create-client'
import { runUpstreamCall, type UpstreamCallOutcome } from '../mcp/tools-proxy'
import { completeJobDone, completeJobError, findJobById } from '../db/queries/async-jobs'
import { buildUsageMsg } from '../usage/record'
import { scrubErrorForStorage } from '../usage/error-detail'
import { mangleToolName } from '../mcp/tool-name'

/**
 * Batch consumer for ctxlayer-jobs. One message per async tool submit
 * (`tools-proxy.ts submitAsyncJob`). The consumer re-dials the upstream with
 * the caller's credentials and runs the real `tools/call` with the full
 * per-upstream budget — a background queue invocation has ~15 min wall-clock,
 * so a 2-3 min tool fits where an interactive client's ~180s request cap would
 * not. The result is stored on the `async_jobs` row for `poll_task` to fetch.
 *
 * A tool-level failure (timeout, upstream error, missing creds) is a TERMINAL
 * `error` job — we ack, since a retry would just fail the same way. Only an
 * unexpected infra throw (DB unavailable) retries the message. `max_batch_size`
 * is 1 so a slow job gets the whole invocation's wall-clock to itself.
 */
const JobMessage = z.object({
  jobId: z.string().min(1),
  userId: z.string().min(1),
  upstreamId: z.string().min(1),
  tool: z.string().min(1),
  argsJson: z.string(),
  sessionId: z.string().default('')
})
type JobMessage = z.infer<typeof JobMessage>

export async function jobsConsumer(
  batch: MessageBatch,
  env: Env,
  _ctx: ExecutionContext
): Promise<void> {
  for (const msg of batch.messages) {
    const parsed = JobMessage.safeParse(msg.body)
    if (!parsed.success) {
      console.error('[jobs-consumer] malformed message; dropping', { id: msg.id })
      msg.ack()
      continue
    }
    try {
      await runJob(env, parsed.data)
      msg.ack()
    } catch (err) {
      // Unexpected (infra) failure — leave the job `running` and retry the
      // message. `runJob` itself never throws for ordinary tool failures.
      console.error('[jobs-consumer] unexpected error; retrying', {
        id: msg.id,
        err: err instanceof Error ? err.message : String(err)
      })
      msg.retry()
    }
  }
}

/**
 * Run one job to completion. `makeClient` is injectable so tests can supply a
 * fake transport (mirrors `UpstreamProxyRegistry`'s `makeClient`); production
 * uses the real factory. Never throws for ordinary tool failures — those
 * become terminal `error` jobs; it only propagates unexpected infra errors so
 * the consumer can retry the message.
 */
export async function runJob(
  env: Env,
  j: JobMessage,
  makeClient: typeof createUpstreamClient = createUpstreamClient
): Promise<void> {
  // Idempotency: a redelivered message whose job already completed is a no-op.
  const existing = await findJobById(env, j.jobId)
  if (!existing || existing.status !== 'running') return

  const t0 = Date.now()
  let args: unknown = {}
  try {
    args = JSON.parse(j.argsJson)
  } catch {
    args = {}
  }

  const row = await getUpstreamById(env, j.upstreamId)
  if (!row) {
    await completeJobError(
      env,
      j.jobId,
      'upstream_gone',
      'The upstream was removed before the job ran.',
      nowSec()
    )
    return
  }
  let conn: UpstreamConnection
  try {
    conn = toUpstreamConnection(row)
  } catch {
    await completeJobError(
      env,
      j.jobId,
      'unsupported_transport',
      'The upstream transport is no longer dialable.',
      nowSec()
    )
    return
  }

  const bearer = await resolveUserUpstreamBearer(env, row, conn, j.userId)
  if (conn.authStrategy !== 'none' && bearer === null) {
    await completeJobError(
      env,
      j.jobId,
      'no_credentials',
      'No usable credential for this upstream — reconnect it from /app/upstreams and resubmit.',
      nowSec()
    )
    return
  }

  const client = makeClient(conn, bearer)
  let outcome: UpstreamCallOutcome
  try {
    outcome = await runUpstreamCall({
      slug: conn.slug,
      toolName: j.tool,
      maxResponseBytes: conn.authConfig.maxResponseBytes,
      run: () => client.callTool(j.tool, args)
    })
  } finally {
    await client.close().catch(() => {})
  }

  if (outcome.status === 'ok') {
    await completeJobDone(env, j.jobId, JSON.stringify(outcome.surface.content), nowSec())
  } else {
    // error/timeout → terminal error job. The surface text is already
    // credential-scrubbed by runUpstreamCall (formatUpstreamError).
    const detail =
      outcome.surface.content[0]?.text ?? outcome.errorDetail ?? outcome.errorCode ?? 'upstream_error'
    await completeJobError(env, j.jobId, outcome.errorCode ?? outcome.status, detail, nowSec())
  }

  // Record the real call in usage (mangled tool name matches the inline path).
  // Sent straight to USAGE_QUEUE — the consumer has no DO SQLite outbox, and a
  // queue-consumer send isn't subject to the streaming-response cancellation
  // race the DO outbox was built to survive. Best-effort: the job is already
  // persisted, so a usage-send hiccup must NOT bubble up and re-run the (2-3
  // min) call — a lost usage row is acceptable, a repeated expensive call is not.
  try {
    await env.USAGE_QUEUE.send(
      buildUsageMsg({
        userId: j.userId,
        sessionId: j.sessionId,
        upstreamId: j.upstreamId,
        tool: mangleToolName(conn.slug, j.tool),
        reqJson: j.argsJson,
        respJson: outcome.respJson,
        latencyMs: Date.now() - t0,
        status: outcome.status,
        truncated: outcome.truncated,
        errorCode: outcome.errorCode,
        errorMessage:
          outcome.errorDetail != null ? scrubErrorForStorage(outcome.errorDetail) : undefined
      })
    )
  } catch (err) {
    console.error('[jobs-consumer] usage enqueue failed (job already stored)', {
      jobId: j.jobId,
      err: err instanceof Error ? err.message : String(err)
    })
  }
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}
