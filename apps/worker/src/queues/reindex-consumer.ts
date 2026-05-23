import type { Env } from '../env'

/**
 * Batch consumer for ctxlayer-reindex. M2 wires:
 *   1. load Y.Doc snapshot from R2
 *   2. convert to markdown via @blocknote/server-util
 *   3. chunk (~512 tokens, 64 overlap, heading-aware)
 *   4. embed via env.AI (@cf/baai/bge-base-en-v1.5)
 *   5. delete + upsert vectors keyed `${docId}:${chunkIdx}` in DOCS_INDEX
 *      with metadata `{docId, chunkIdx, revisionId, title, tag_teams,
 *      tag_products, is_global}` (see PLAN.md Section F3)
 * Skeleton: ack-only, retry on per-message error.
 */
export async function reindexConsumer(
  batch: MessageBatch,
  _env: Env,
  _ctx: ExecutionContext
): Promise<void> {
  for (const msg of batch.messages) {
    try {
      // M2: handle(msg.body, env, ctx)
      msg.ack()
    } catch (err) {
      console.error('reindex-consumer error', err)
      msg.retry()
    }
  }
}
