/**
 * Vectorize upsert. Idempotency contract:
 *
 *   1. Delete orphan chunks. If the previous revision produced more
 *      chunks than the new one, every id in `[newCount, prevCount-1]`
 *      now points at stale content and must be removed.
 *   2. Upsert the new chunks with ids `${docId}:${chunkIdx}`.
 *
 * `{docId, revisionId}` may be delivered to the consumer more than
 * once (Cloudflare Queues at-least-once + our own `msg.retry()`).
 * The chunkIdx-based id makes the upsert step idempotent: rerunning
 * lands the same bytes against the same ids. The delete step is also
 * safe to repeat — deleting an id that doesn't exist is a no-op.
 */

import type { Env } from '../env'

export interface ChunkVector {
  /** Stable across revisions: `${docId}:${chunkIdx}`. */
  id: string
  values: number[]
  metadata: ChunkMetadata
}

// Vectorize's VectorizeVector type requires metadata to be a
// `Record<string, VectorizeVectorMetadata>` (i.e. an index signature).
// We add the index signature here so the upsert call typechecks
// without `as any`, while keeping the named fields the rag tools
// read out.
export interface ChunkMetadata {
  [key: string]: string | number | boolean | string[]
  docId: string
  chunkIdx: number
  revisionId: string
  title: string
  /** First few headings active at the chunk start, top-down. */
  headings: string[]
  tag_teams: string[]
  tag_products: string[]
  is_global: boolean
  /** The chunk's text. Stored so search results can return snippets
   *  without an extra R2 hop. Vectorize allows up to ~10KB metadata
   *  per vector; a 512-token chunk fits comfortably (~2-4KB). */
  text: string
}

export interface UpsertInput {
  docId: string
  revisionId: string
  title: string
  chunks: Array<{ idx: number; text: string; headings: string[]; tokenCount: number }>
  vectors: number[][]
  tags?: { teams: string[]; products: string[] }
  /** Previous chunk_count for this doc; orphans in [newCount, prevCount-1]
   *  are deleted before upsert. Pass 0 on first reindex. */
  previousChunkCount: number
}

export async function upsertChunks(env: Env, input: UpsertInput): Promise<void> {
  if (input.chunks.length !== input.vectors.length) {
    throw new Error(
      `rag/index: chunks/vectors length mismatch (${input.chunks.length} vs ${input.vectors.length})`
    )
  }
  const tags = input.tags ?? { teams: [], products: [] }
  const isGlobal = tags.teams.length === 0 && tags.products.length === 0

  const payload: ChunkVector[] = input.chunks.map((c, i) => {
    const values = input.vectors[i]
    if (!values) {
      throw new Error(`rag/index: missing vector at index ${i}`)
    }
    return {
      id: `${input.docId}:${c.idx}`,
      values,
      metadata: {
        docId: input.docId,
        chunkIdx: c.idx,
        revisionId: input.revisionId,
        title: input.title,
        headings: c.headings,
        tag_teams: tags.teams,
        tag_products: tags.products,
        is_global: isGlobal,
        text: c.text
      }
    }
  })

  // Step 1: clean up orphans. Vectorize doesn't have a delete-by-prefix
  // API; we compute the exact ids that should disappear.
  const newCount = input.chunks.length
  if (input.previousChunkCount > newCount) {
    const orphans: string[] = []
    for (let i = newCount; i < input.previousChunkCount; i++) {
      orphans.push(`${input.docId}:${i}`)
    }
    if (orphans.length > 0) {
      await env.DOCS_INDEX.deleteByIds(orphans).catch((err) => {
        // Non-fatal: stale orphans are bad but not as bad as failing
        // the whole reindex. Log + continue so the new chunks still
        // land.
        console.warn('rag/index: orphan delete failed', {
          docId: input.docId,
          orphans: orphans.length,
          err: err instanceof Error ? err.message : String(err)
        })
      })
    }
  }

  // Step 2: upsert the new chunks.
  if (payload.length > 0) {
    await env.DOCS_INDEX.upsert(payload)
  }
}
