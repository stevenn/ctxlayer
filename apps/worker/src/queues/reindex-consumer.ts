import { z } from 'zod'
import type { Env } from '../env'
import { getDocById } from '../db/queries/docs'
import { listTagsForDoc } from '../db/queries/doc-tags'
import { readRevision } from '../storage/docs-r2'
import { renderBlocksToMarkdown } from '../rag/markdown'
import { chunkMarkdown } from '../rag/chunker'
import { embed } from '../rag/embedder'
import { upsertChunks } from '../rag/index'

/**
 * Batch consumer for ctxlayer-reindex.
 *
 * Per message: R2 read → markdown render → chunk → embed → upsert.
 * The upsert is stubbed in M2b/1 (logs the payload); M2c flips
 * `rag/index.ts` to call Vectorize without touching this file.
 *
 * Failure model:
 *   - Malformed message body → ack + log (no DLQ yet; replaying it
 *     would loop the batch). G4 in PLAN.md tracks the DLQ work.
 *   - Doc/revision missing (e.g. deleted between produce and consume)
 *     → ack + log; nothing to reindex.
 *   - Transient pipeline error (R2/AI/D1) → `retry()` so the queue
 *     redelivers with backoff.
 */
const ReindexMessage = z.object({
  docId: z.string().min(1),
  revisionId: z.string().min(1)
})

export async function reindexConsumer(
  batch: MessageBatch,
  env: Env,
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
      await handle(env, parsed.data.docId, parsed.data.revisionId)
      msg.ack()
    } catch (err) {
      console.error('reindex-consumer: pipeline error; retrying', {
        id: msg.id,
        body: parsed.data,
        err: err instanceof Error ? err.message : String(err)
      })
      msg.retry()
    }
  }
}

async function handle(env: Env, docId: string, revisionId: string): Promise<void> {
  const doc = await getDocById(env, docId)
  if (!doc) {
    console.log('reindex-consumer: doc gone; skipping', { docId, revisionId })
    return
  }
  const content = await readRevision(env, docId, revisionId)
  if (!content) {
    console.log('reindex-consumer: revision body missing; skipping', { docId, revisionId })
    return
  }

  let markdown: string
  try {
    markdown = renderBlocksToMarkdown(content.blocks)
  } catch (err) {
    // We've now defended renderInline + renderTable, but if a future
    // BlockNote schema change still trips us, log a sample of the
    // payload so the offending block is identifiable from the queue
    // log instead of just `items.map is not a function`.
    console.error('reindex-consumer: markdown render failed', {
      docId,
      revisionId,
      blockCount: Array.isArray(content.blocks) ? content.blocks.length : 'not-an-array',
      sample: safeSample(content.blocks)
    })
    throw err
  }
  if (!markdown) {
    // Empty body — nothing to embed. M2c's delete-by-docId-prefix will
    // still want to run so search results don't reference an empty
    // doc, but in M2b/1 we just log and return.
    console.log('reindex-consumer: empty markdown; skipping', { docId, revisionId })
    return
  }

  const chunks = chunkMarkdown(markdown)
  const [{ vectors }, tags] = await Promise.all([
    embed(env, chunks.map((c) => c.text)),
    listTagsForDoc(env, docId)
  ])
  // Topic tags aren't part of the search filter today; we pass only
  // team + product onto chunk metadata. Topics live in `doc_tags`
  // for the editor + (future) drill-down browse, not the scope
  // predicate. `is_global` is derived in upsertChunks from these two.
  await upsertChunks(env, {
    docId,
    revisionId,
    title: doc.title,
    chunks,
    vectors,
    tags: { teams: tags.teams, products: tags.products }
  })
}

function safeSample(blocks: unknown): string {
  try {
    return JSON.stringify(blocks).slice(0, 500)
  } catch {
    return '<unstringifiable>'
  }
}
