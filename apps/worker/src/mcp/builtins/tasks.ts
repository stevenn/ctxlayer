import { findJobById, listJobsForUser } from '../../db/queries/async-jobs'
import { BUILTIN_INPUT_SHAPES } from '../builtin-schemas'
import { sanitizeUntrustedContent, sanitizeUntrustedText } from '../provenance'
import { errText } from '../tool-result'
import { defineBuiltin, type BuiltinResult } from './types'

// ----- async submit→poll built-ins -----
// Slow upstream tools (per authConfig.asyncTools) run in the ctxlayer-jobs
// consumer and return a job token; poll_task fetches the result once ready
// (list_tasks recovers a lost job id). See mcp/async-submit.ts submitAsyncJob +
// docs/plan/I-upstream-resilience.md §I9. Both are pure D1: a job belongs to
// a user, not to a session or a lane, so a job submitted on one lane can be
// polled from the other.

const text = (t: string): BuiltinResult => ({ content: [{ type: 'text', text: t }] })

/** `poll_task` — fetch an async job's result. */
export const pollTask = defineBuiltin({
  name: 'poll_task',
  inputShape: BUILTIN_INPUT_SHAPES.poll_task,
  run: async (args, { env, user }) => {
    const userId = user?.userId
    if (!userId) return errText('not_signed_in')
    const job = await findJobById(env, args.job_id)
    // Same not_found for missing OR not-owned — don't leak that a job id
    // exists for another user.
    if (!job || job.user_id !== userId) return errText('not_found: no such job')
    if (job.status === 'running') {
      const elapsed = Math.floor(Date.now() / 1000) - job.created_at
      return text(
        `still_running: job ${job.id} has run ${elapsed}s. Call poll_task again in ~30s.`
      )
    }
    if (job.status === 'error') {
      // error_detail is upstream text replayed from storage — gate it
      // here at the read site, so no storage-shape drift in the queue
      // consumer can ever hand the agent raw upstream bytes.
      return errText(sanitizeUntrustedText(job.error_detail ?? job.error_code ?? 'upstream_error'))
    }
    // done — replay the stored upstream content array verbatim. The
    // result blob is cleared ~1 day after completion (retry-warm is 15
    // min), so a very-late poll finds it gone.
    if (job.result_json == null) {
      return text(
        `result_expired: job ${job.id} completed but its result is no longer cached (results are retained ~1 day). Re-run the tool to recompute.`
      )
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(job.result_json)
    } catch {
      parsed = null
    }
    // Stored results were sanitised at capture time; re-apply the gate
    // at replay (same belt-and-suspenders as the error branch above).
    const content = sanitizeUntrustedContent(
      (Array.isArray(parsed) ? parsed : [{ type: 'text', text: job.result_json ?? '' }]) as Array<{
        type: 'text'
        text: string
      }>
    )
    return {
      content,
      // Bill the delivery, not the payload: the queue consumer already
      // counted it under the real upstream tool. Running/error/expired polls
      // above fall back to their (small) real content.
      usageResp: `delivered: '${job.tool}' result replayed to the agent (tokens billed on the upstream tool, not poll_task).`
    }
  }
})

/** `list_tasks` — the caller's recent async jobs (recovers a lost job id). */
export const listTasks = defineBuiltin({
  name: 'list_tasks',
  run: async (_args, { env, user }) => {
    const userId = user?.userId
    if (!userId) return errText('not_signed_in')
    const jobs = await listJobsForUser(env, userId, 20)
    const body = jobs.map((j) => ({
      job_id: j.id,
      tool: j.tool,
      status: j.status,
      created_at: j.created_at,
      completed_at: j.completed_at
    }))
    return text(JSON.stringify(body, null, 2))
  }
})
