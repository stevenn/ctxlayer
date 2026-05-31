import { z } from 'zod'
import type { Env } from '../env'
import { runGitSync } from '../git/sync'

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
      const result = await runGitSync(env, parsed.data.sourceId, { userId: parsed.data.userId })
      if (result.status === 'error') {
        console.warn('git-sync-consumer: sync recorded error', {
          sourceId: parsed.data.sourceId,
          error: result.error
        })
      }
      msg.ack()
    } catch (err) {
      console.error('git-sync-consumer: unexpected error; retrying', {
        id: msg.id,
        err: err instanceof Error ? err.message : String(err)
      })
      msg.retry()
    }
  }
}
