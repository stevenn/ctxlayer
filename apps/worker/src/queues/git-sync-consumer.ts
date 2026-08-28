import { z } from 'zod'
import type { Env } from '../env'
import { getGitSourceById } from '../db/queries/git-sources'
import { runGitSync } from '../git/sync'
import { recordJobRun } from '../ops/job-runs'
import { errMessage } from '../util/errors'

/**
 * Batch consumer for ctxlayer-git-sync. One message per source per run.
 *
 * `runGitSync` records its own status on the source row and never throws
 * for ordinary sync failures (provider errors, no token) — those are
 * persisted as `last_sync_status='error'` and acked, since the next
 * scheduled/manual run retries. Only a truly unexpected throw retries
 * the message.
 */
const GitSyncMessage = z.object({
  sourceId: z.string().min(1),
  // Acting user for user_* read strategies (interactive "Sync now").
  userId: z.string().optional()
})

export async function gitSyncConsumer(
  batch: MessageBatch,
  env: Env,
  _ctx: ExecutionContext
): Promise<void> {
  for (const msg of batch.messages) {
    const parsed = GitSyncMessage.safeParse(msg.body)
    if (!parsed.success) {
      console.error('git-sync-consumer: malformed message; dropping', { id: msg.id })
      msg.ack()
      continue
    }
    try {
      // Ledger one row per source run (Admin · Jobs) — before this, each
      // run overwrote the source's last_sync_* columns and history was
      // gone. An ordinary sync failure is a 'error' ROW (not a throw);
      // a truly unexpected throw is recorded too, then retried below.
      await recordJobRun(env, 'git-sync', async () => {
        const source = await getGitSourceById(env, parsed.data.sourceId)
        const result = await runGitSync(env, parsed.data.sourceId, { userId: parsed.data.userId })
        if (result.status === 'error') {
          console.warn('git-sync-consumer: sync recorded error', {
            sourceId: parsed.data.sourceId,
            error: result.error
          })
        }
        const { status, error, ...counts } = result
        return {
          status,
          summary: { source: source?.slug ?? parsed.data.sourceId, ...counts },
          ...(error ? { error } : {})
        }
      })
      msg.ack()
    } catch (err) {
      console.error('git-sync-consumer: unexpected error; retrying', {
        id: msg.id,
        err: errMessage(err)
      })
      msg.retry()
    }
  }
}
