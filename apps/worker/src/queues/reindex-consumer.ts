import type { Env } from '../env'

/**
 * Batch consumer for ctxlayer-reindex. M2 wires:
 *   1. load Y.Doc snapshot from R2
 *   2. convert to markdown via @blocknote/server-util
 *   3. chunk (~512 tokens, 64 overlap, heading-aware)
 *   4. embed via env.AI (@cf/baai/bge-base-en-v1.5)
 *   5. delete + upsert vectors keyed `${docId}:${chunkIdx}` in DOCS_INDEX
 */
export async function reindexConsumer(batch: MessageBatch, _env: Env): Promise<void> {
  for (const msg of batch.messages) {
    msg.ack()
  }
}
