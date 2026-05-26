import type { Env } from '../env'
import { UsageEventMsg } from '../usage/event'
import { writeUsageEvent } from '../db/queries/usage'

/**
 * Batch consumer for ctxlayer-usage. One D1 batch per message
 * (raw INSERT + rollup UPSERT) — see `db/queries/usage.ts`.
 *
 * Ack per message rather than per batch so a single poison row can't
 * stall the whole queue. The producer-side validation already enforces
 * the message shape, but parse-with-recovery here defends against
 * stale messages from older worker versions.
 */
export async function usageConsumer(
  batch: MessageBatch,
  env: Env,
  _ctx: ExecutionContext
): Promise<void> {
  for (const msg of batch.messages) {
    try {
      const parsed = UsageEventMsg.safeParse(msg.body)
      if (!parsed.success) {
        // Bad shape will never become good — ack and move on.
        console.error('[usage-consumer] dropping malformed message', parsed.error.issues)
        msg.ack()
        continue
      }
      await writeUsageEvent(env, parsed.data)
      msg.ack()
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err)
      console.error(`[usage-consumer] write failed: ${m}`)
      msg.retry()
    }
  }
}
