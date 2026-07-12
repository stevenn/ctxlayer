/**
 * Map a delivered queue name to its consumer kind.
 *
 * Queue names are deployment-specific: the canonical worker uses
 * `ctxlayer-usage` etc., but every provisioned tenant prefixes them with the
 * worker name (`${WORKER}-usage` → e.g. `ctxlayer-yukitools-usage`, see the ops
 * wrangler template). So the queue handler MUST match on the type suffix, not an
 * exact base name — otherwise a tenant's batches match no branch and get
 * retried-then-dropped, silently disabling usage/reindex/git-sync on every
 * non-canonical deployment.
 *
 * The suffixes don't overlap, and the type word is always the last `-`-segment
 * (it's appended after the worker name), so suffix matching can't misroute.
 */
export type QueueKind = 'usage' | 'reindex' | 'git-sync' | 'jobs'

export function queueKind(name: string): QueueKind | null {
  if (name.endsWith('-usage')) return 'usage'
  if (name.endsWith('-reindex')) return 'reindex'
  if (name.endsWith('-git-sync')) return 'git-sync'
  if (name.endsWith('-jobs')) return 'jobs'
  return null
}
