import { z } from 'zod'
import type { Env } from '../env'

/**
 * Batch consumer for ctxlayer-reindex.
 *
 * M2a: validate the new {docId, revisionId} payload shape (produced
 * by `PUT /api/docs/:id/content` and `POST /api/docs/:id/restore`)
 * and ack. The actual reindex pipeline lands in M2b:
 *   1. load revision body from R2 (storage/docs-r2.readRevision)
 *   2. render BlockNote JSON -> markdown via @blocknote/server-util
 *   3. chunk (~512 tokens, 64 overlap, heading-aware)
 *   4. embed via env.AI (@cf/baai/bge-base-en-v1.5)
 *   5. delete + upsert vectors keyed `${docId}:${chunkIdx}` with
 *      metadata `{docId, chunkIdx, revisionId, title, tag_teams,
 *      tag_products, is_global}` (see PLAN.md Section F3)
 *
 * Malformed payloads ack instead of retrying — replaying a bad message
 * stalls the batch and there's no DLQ yet (G4). They're logged so a
 * mis-shaped producer is debuggable.
 */
const ReindexMessage = z.object({
  docId: z.string().min(1),
  revisionId: z.string().min(1)
})

export async function reindexConsumer(
  batch: MessageBatch,
  _env: Env,
  _ctx: ExecutionContext
): Promise<void> {
  for (const msg of batch.messages) {
    const parsed = ReindexMessage.safeParse(msg.body)
    if (!parsed.success) {
      console.error('reindex-consumer: malformed message; dropping', {
        id: msg.id,
        issues: parsed.error.issues
      })
      msg.ack()
      continue
    }
    try {
      // M2b: const { docId, revisionId } = parsed.data; await handle(...)
      msg.ack()
    } catch (err) {
      console.error('reindex-consumer error', { id: msg.id, err })
      msg.retry()
    }
  }
}
