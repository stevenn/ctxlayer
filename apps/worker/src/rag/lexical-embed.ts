/**
 * Lexical-as-dense embedding (the "hashing trick"). A chunk's keywords are
 * hashed into a fixed-dimension vector with sublinear-TF weights and
 * L2-normalised, so cosine over these vectors approximates lexical
 * overlap. Stored in a SECOND Vectorize index (`DOCS_LEXICAL_INDEX`) and
 * unioned with the dense (bge) candidates at query time — giving keyword
 * recall (exact terms, identifiers, acronyms the dense model misses)
 * entirely within Vectorize, no D1 inverted index, no FTS5.
 *
 * It's deliberately approximate: 1536 dims (Vectorize's max) means a
 * code-heavy vocabulary collides, and there's no IDF (stopwords removed,
 * sublinear TF only). That's fine — this stage is for RECALL; the
 * cross-encoder reranker re-scores candidates against the real text, so
 * collision noise gets demoted. IDF (a small term-df store) is the obvious
 * future sharpening if precision needs it.
 *
 * Pure + dependency-free (besides the shared stopword set) so it's
 * unit-tested without the worker runtime.
 */

import { STOPWORDS } from '@ctxlayer/shared'

// Vectorize caps vectors at 1536 dims (32-bit). Max dim = fewest collisions.
export const LEXICAL_DIM = 1536

/**
 * Lexical tokens (WITH duplicates, for term frequency): lowercased
 * alphanumeric runs ≥2 chars, minus stopwords. ≥2 (not ≥3 like
 * significantTerms) so short identifiers/acronyms — `vb`, `db`, `id` — still
 * index. Index-time and query-time must call this identically.
 */
export function lexicalTokens(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? []
  return words.filter((w) => w.length >= 2 && !STOPWORDS.has(w))
}

/** Stable 32-bit FNV-1a hash → dimension bucket. */
function hashTerm(term: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < term.length; i++) {
    h ^= term.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * Hash a text's keywords into an L2-normalised `LEXICAL_DIM` vector.
 * Returns null when there are no lexical tokens (a chunk/query of pure
 * symbols/stopwords) — callers skip the upsert/query for it, since a zero
 * vector has no meaningful cosine and Vectorize rejects it.
 */
export function lexicalVector(text: string): number[] | null {
  const toks = lexicalTokens(text)
  if (toks.length === 0) return null

  const tf = new Map<string, number>()
  for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1)

  const vec = new Array<number>(LEXICAL_DIM).fill(0)
  for (const [term, count] of tf) {
    const dim = hashTerm(term) % LEXICAL_DIM
    vec[dim] = (vec[dim] ?? 0) + 1 + Math.log(count) // sublinear TF; collisions sum
  }

  let norm = 0
  for (const x of vec) norm += x * x
  norm = Math.sqrt(norm)
  if (norm === 0) return null
  for (let i = 0; i < LEXICAL_DIM; i++) vec[i] = (vec[i] ?? 0) / norm
  return vec
}
