import type { Env } from '../env'

/**
 * Batch consumer for ctxlayer-usage. M6 turns this into:
 *   1. tokenize req/resp JSON via js-tiktoken
 *   2. INSERT into usage_events
 *   3. UPSERT into usage_rollups_daily
 * For the skeleton we just ack the batch so the queue doesn't back up.
 */
export async function usageConsumer(batch: MessageBatch, _env: Env): Promise<void> {
  for (const msg of batch.messages) {
    msg.ack()
  }
}
