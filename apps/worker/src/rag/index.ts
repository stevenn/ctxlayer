/**
 * Vectorize upsert facade. In M2b/1 this is intentionally a logger:
 * we build the exact payload that M2c will hand to
 * `env.DOCS_INDEX.upsert(...)` and print it so the producer side can
 * be exercised end-to-end without a real index. The function
 * signature does not change in M2c — only the body.
 *
 * # Idempotency contract (M2c implementation must honour)
 *
 * `{docId, revisionId}` may be delivered to the consumer more than
 * once (Cloudflare Queues at-least-once semantics, plus our own
 * `msg.retry()` on transient failures). The real upsert must be safe
 * to re-run:
 *
 *   1. Delete every existing vector whose id has the prefix
 *      `${docId}:` (this drops stale chunks from previous revisions
 *      AND any prior copy of the current revision's chunks).
 *      Use `env.DOCS_INDEX.deleteByIds([...])` after listing them, or
 *      a metadata filter if Vectorize supports `deleteByMetadata`.
 *   2. Upsert the new chunks with ids `${docId}:${chunkIdx}`.
 *
 * The chunkIdx-based id ensures two consumers racing on the same
 * (docId, revisionId) converge to the same final state — last writer
 * wins per id, but every id is present and matches the latest
 * revision's chunks.
 *
 * Metadata stays additive: M2b/1 always emits `is_global: true` with
 * empty team/product arrays. M2b/2 populates from `doc_tags`. M2c's
 * search filter joins on these fields.
 */

import type { Env } from '../env'

export interface ChunkVector {
  /** Stable across revisions: `${docId}:${chunkIdx}`. */
  id: string
  values: number[]
  metadata: ChunkMetadata
}

export interface ChunkMetadata {
  docId: string
  chunkIdx: number
  revisionId: string
  title: string
  /** First few headings active at the chunk start, top-down. */
  headings: string[]
  tag_teams: string[]
  tag_products: string[]
  is_global: boolean
}

export interface UpsertInput {
  docId: string
  revisionId: string
  title: string
  chunks: Array<{ idx: number; text: string; headings: string[]; tokenCount: number }>
  vectors: number[][]
  tags?: { teams: string[]; products: string[] }
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
      // Caller-guaranteed: we checked lengths match above. Throw
      // rather than emit a bad vector so the queue retries the work.
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
        is_global: isGlobal
      }
    }
  })
  // M2b/1: log and return. M2c flips this to:
  //   await deleteByDocPrefix(env, input.docId)
  //   await env.DOCS_INDEX.upsert(payload)
  console.log('rag/index: would upsert', {
    docId: input.docId,
    revisionId: input.revisionId,
    chunkCount: payload.length,
    sampleVectorDim: payload[0]?.values.length ?? 0,
    sampleMetadata: payload[0]?.metadata
  })
  // Touch env so the unused-arg lint doesn't fire and so the call
  // site type-checks identically once the real binding is in use.
  void env.DOCS_INDEX
}
