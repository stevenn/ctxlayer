import type { Env } from '../env'

/**
 * Batch consumer for ctxlayer-usage. M6 turns this into:
 *   1. tokenize req/resp JSON via js-tiktoken
 *   2. INSERT into usage_events
 *   3. UPSERT into usage_rollups_daily (translating NULL upstream_id to ''
 *      to match the rollup PK)
 * Skeleton: ack each message individually, retry on per-message error so
 * a poison message doesn't stall a whole batch. ctx is reserved for
 * `waitUntil` of post-ack fire-and-forget work.
 */
export async function usageConsumer(
  batch: MessageBatch,
  _env: Env,
  _ctx: ExecutionContext
): Promise<void> {
  for (const msg of batch.messages) {
    try {
      // M6: handle(msg.body, env, ctx)
      msg.ack()
    } catch (err) {
      console.error('usage-consumer error', err)
      msg.retry()
    }
  }
}
