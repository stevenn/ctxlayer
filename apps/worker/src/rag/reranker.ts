/**
 * Cross-encoder reranking. Dense retrieval (bge-base) is recall-oriented
 * but its ordering is imprecise; `@cf/baai/bge-reranker-base` scores each
 * (query, passage) pair directly and reorders the candidates, which is the
 * single biggest lever on "the result doesn't relate to my terms".
 *
 * Best-effort, like query-understanding: any failure (binding unavailable
 * under `wrangler dev`, AI error, or an unparseable response — the binding
 * output shape has had quirks, cf. workerd#5998) returns null so the caller
 * falls back to dense order. Search must never error on the reranker.
 *
 * `applyRerank` + `parseRerankResponse` are pure so the ordering/floor
 * logic is unit-tested without the AI binding.
 */

import type { Env } from '../env'
import type { ChunkMetadata } from './index'
import { isLocalRemoteBindingError } from './ai-util'

const RERANK_MODEL = '@cf/baai/bge-reranker-base'

export interface Candidate {
  metadata: ChunkMetadata
  denseScore: number
}

export interface RerankResult {
  candidate: Candidate
  /** sigmoid(reranker logit) in [0,1]. */
  rerankScore: number
}

interface RerankItem {
  /** Index into the contexts array we sent (== candidate index). */
  id: number
  score: number
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x))
}

/** Heading breadcrumb + body — the text handed to the cross-encoder. */
function contextText(m: ChunkMetadata): string {
  const crumb = (m.headings ?? []).filter(Boolean).join(' › ')
  const header = [m.title, crumb].filter(Boolean).join(' › ')
  return header ? `${header}\n\n${m.text}` : m.text
}

/** Defensive parse of the bge-reranker response: `{ response: [{id,score}] }`. */
export function parseRerankResponse(resp: unknown): RerankItem[] | null {
  const arr = (resp as { response?: unknown } | null)?.response
  if (!Array.isArray(arr)) return null
  const items: RerankItem[] = []
  for (const x of arr) {
    if (x && typeof x === 'object') {
      const id = (x as { id?: unknown }).id
      const score = (x as { score?: unknown }).score
      if (typeof id === 'number' && typeof score === 'number') items.push({ id, score })
    }
  }
  return items.length > 0 ? items : null
}

/**
 * Pure: map reranker items (id → candidate index) to floored, sorted,
 * top-k results. `floor` is compared against the sigmoid-normalised score.
 */
export function applyRerank(
  candidates: Candidate[],
  items: RerankItem[],
  opts: { k: number; floor: number }
): RerankResult[] {
  const out: RerankResult[] = []
  for (const it of items) {
    const candidate = candidates[it.id]
    if (!candidate) continue
    const rerankScore = sigmoid(it.score)
    if (rerankScore < opts.floor) continue
    out.push({ candidate, rerankScore })
  }
  out.sort((a, b) => b.rerankScore - a.rerankScore)
  return out.slice(0, opts.k)
}

/**
 * Rerank dense candidates. Returns top-k floored results, or `null` to
 * signal the caller should fall back to dense order.
 */
export async function rerankCandidates(
  env: Env,
  query: string,
  candidates: Candidate[],
  opts: { k: number; floor: number }
): Promise<RerankResult[] | null> {
  if (candidates.length === 0) return []
  try {
    const resp = await env.AI.run(RERANK_MODEL, {
      query,
      contexts: candidates.map((c) => ({ text: contextText(c.metadata) })),
      top_k: candidates.length
    } as never)
    const items = parseRerankResponse(resp)
    if (!items) {
      console.warn('reranker: unparseable response; dense fallback')
      return null
    }
    return applyRerank(candidates, items, opts)
  } catch (err) {
    if (!isLocalRemoteBindingError(err)) {
      console.warn('reranker: call failed; dense fallback', {
        err: err instanceof Error ? err.message : String(err)
      })
    }
    return null
  }
}

export { RERANK_MODEL }
