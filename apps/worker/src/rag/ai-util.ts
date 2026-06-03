/**
 * Shared detection for the "binding needs to be run remotely" failure that
 * Workers AI + Vectorize raise under a plain `wrangler dev`. Lets the
 * search + rerank paths degrade gracefully (empty results / dense
 * fallback) locally instead of 500-ing; real production errors fall
 * through and surface normally. Used by both retrieveCandidates and the
 * reranker, so it lives on its own to avoid a search↔reranker import cycle.
 */
export function isLocalRemoteBindingError(err: unknown): boolean {
  if (err && typeof err === 'object' && (err as { remote?: unknown }).remote === true) return true
  const msg = err instanceof Error ? err.message : String(err)
  return /needs to be run remotely/i.test(msg)
}
