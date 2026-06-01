/**
 * Shared semantic-search core. One implementation behind both the MCP
 * `search_docs` tool and the REST `POST /api/search` endpoint, so the
 * two never drift.
 *
 * `searchChunks` is the pure retrieval primitive: embed N query strings
 * → query Vectorize once per vector (overshooting topK so the scope
 * post-filter has headroom) → merge by chunk id keeping the max score →
 * scope-filter → slice to k. For a single query this is byte-identical
 * to the original `search_docs` behaviour.
 *
 * `runSearch` is the REST orchestrator: resolve the caller's scope,
 * retrieve, group hits by doc, and wrap them in the interpretation
 * envelope the SPA renders. The LLM query-understanding step slots in
 * here in a later phase; for now `interpretation` echoes the raw query.
 */

import type { Env } from '../env'
import type { ChunkMetadata } from './index'
import type {
  SearchDocGroup,
  SearchInterpretation,
  SearchResponse,
  SearchScope
} from '@ctxlayer/shared'
import { headingAnchor } from '@ctxlayer/shared'
import type { SuggestedFilter } from '@ctxlayer/shared'
import { embed } from './embedder'
import { understandQuery, type AvailableScope } from './query-understanding'
import { resolveUserScope } from '../db/queries/doc-tags'
import { getDocById, gitDocIdsAmong } from '../db/queries/docs'
import { listTeams } from '../db/queries/teams'
import { listProducts } from '../db/queries/products'

export const SEARCH_K_DEFAULT = 8
export const SEARCH_K_MAX = 50
// Overshoot topK so the scope post-filter has headroom when many chunks
// don't match the caller's scope. Vectorize caps topK at 50 when
// `returnMetadata: 'all'` — which we always pass to read chunk metadata
// — so asking for more is a hard 40025 error (k≥17 once overshot ×3).
const SEARCH_OVERSHOOT = 3
const VECTORIZE_TOPK_MAX = 50
const SNIPPET_MAX = 600
// Minimum cosine score to count as a real hit — drops weak matches so a
// vague query doesn't surface barely-related chunks. Tunable against the
// live index (bge-base cosine: relevant ≳ 0.6, weak ≈ 0.45-0.55).
const SCORE_FLOOR = 0.5

/** A single matching chunk, scope-filtered and ready to return. */
export interface SearchHit {
  docId: string
  chunkIdx: number
  title: string
  headings: string[]
  score: number
  snippet: string
}

export interface EffectiveScope {
  teams: string[]
  products: string[]
  includeGlobal: boolean
  /** When true, skip all metadata filtering. */
  all: boolean
}

/**
 * Resolve the requested scope against the caller's reachable set.
 *
 * Open-read stance: docs are readable by everyone (see `listDocs`), so
 * search must not HIDE docs by default — tags organize and narrow, they
 * don't gate reads. With no scope supplied (or `scope: 'all'`) the
 * filter is disabled and the whole library is searchable. An explicit
 * `{teams,products}` still NARROWS, intersected with what the caller can
 * reach so a supplied id can only restrict, never escalate.
 */
export function effectiveScope(
  scope: SearchScope | undefined,
  user: { teams: string[]; products: string[] }
): EffectiveScope {
  // No scope OR explicit "all" → open-read: search every doc.
  if (!scope || scope === 'all') {
    return { teams: [], products: [], includeGlobal: true, all: true }
  }
  const teams = (scope.teams ?? user.teams).filter((t) => user.teams.includes(t))
  const products = (scope.products ?? user.products).filter((p) => user.products.includes(p))
  return { teams, products, includeGlobal: true, all: false }
}

function passesScope(m: ChunkMetadata, scope: EffectiveScope): boolean {
  if (scope.all) return true
  if (scope.includeGlobal && m.is_global) return true
  if (m.tag_teams.some((t) => scope.teams.includes(t))) return true
  if (m.tag_products.some((p) => scope.products.includes(p))) return true
  return false
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n - 1) + '…'
}

/**
 * True for the "binding needs to be run remotely" failure that
 * Workers AI + Vectorize raise under a plain `wrangler dev`. Lets the
 * search path degrade to empty results locally instead of 500-ing; real
 * production errors fall through and surface normally.
 */
function isLocalRemoteBindingError(err: unknown): boolean {
  if (err && typeof err === 'object' && (err as { remote?: unknown }).remote === true) return true
  const msg = err instanceof Error ? err.message : String(err)
  return /needs to be run remotely/i.test(msg)
}

/**
 * Embed one or more query strings, query Vectorize for each, merge the
 * matches by chunk id (keeping the highest score across queries), apply
 * the scope filter, and return the top `k` hits sorted by score.
 */
export async function searchChunks(
  env: Env,
  queries: string[],
  opts: { k: number; effective: EffectiveScope }
): Promise<SearchHit[]> {
  const cleaned = queries.map((q) => q.trim()).filter(Boolean)
  if (cleaned.length === 0) return []

  // The embedder (Workers AI) and Vectorize don't work under a plain
  // `wrangler dev` — they throw "needs to be run remotely". Locally
  // there are no vectors anyway (the reindex consumer soft-skips), so
  // degrade to empty results instead of a 500. Real errors still
  // propagate (and surface as 500) in production.
  const topK = Math.min(opts.k * SEARCH_OVERSHOOT, VECTORIZE_TOPK_MAX)
  let results: Awaited<ReturnType<typeof env.DOCS_INDEX.query>>[]
  try {
    const { vectors } = await embed(env, cleaned)
    if (vectors.length === 0) return []
    results = await Promise.all(
      vectors.map((v) => env.DOCS_INDEX.query(v, { topK, returnMetadata: 'all' }))
    )
  } catch (err) {
    if (isLocalRemoteBindingError(err)) {
      console.warn('rag/search: AI/Vectorize unavailable in dev (run --remote or deploy)')
      return []
    }
    throw err
  }

  // Merge across queries by chunk id, keeping the best score (scope is
  // applied below, not here, so we can let git docs bypass it).
  const best = new Map<string, { metadata: ChunkMetadata; score: number }>()
  for (const result of results) {
    for (const m of result.matches ?? []) {
      const metadata = m.metadata as unknown as ChunkMetadata
      const id = `${metadata.docId}:${metadata.chunkIdx}`
      const prev = best.get(id)
      if (!prev || m.score > prev.score) best.set(id, { metadata, score: m.score })
    }
  }

  const candidates = [...best.values()]
  // Git-synced docs are always searchable regardless of their team/
  // product tag (the tag organizes, it doesn't gate search). Resolve
  // which candidate docs are git in one query, then keep a chunk if it's
  // git OR passes the caller's scope.
  const gitDocIds = await gitDocIdsAmong(env, [...new Set(candidates.map((c) => c.metadata.docId))])

  return candidates
    .filter((c) => gitDocIds.has(c.metadata.docId) || passesScope(c.metadata, opts.effective))
    .filter((c) => c.score >= SCORE_FLOOR)
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.k)
    .map(({ metadata, score }) => ({
      docId: metadata.docId,
      chunkIdx: metadata.chunkIdx,
      title: metadata.title,
      headings: metadata.headings,
      score,
      snippet: truncate(metadata.text, SNIPPET_MAX)
    }))
}

export interface RunSearchInput {
  query: string
  k?: number
  scope?: SearchScope
}

/**
 * REST orchestrator. Predictable baseline: embed the caller's query
 * verbatim and search open-read across the whole library by default (an
 * explicit request scope still narrows it — that's how a clicked filter
 * chip works). The
 * LLM runs in PARALLEL purely to surface optional `suggestedFilters`;
 * it never rewrites the query or auto-narrows results, so it can't
 * silently distort relevance (and adds no latency to retrieval).
 */
export async function runSearch(
  env: Env,
  userId: string,
  input: RunSearchInput
): Promise<SearchResponse> {
  const userScope = await resolveUserScope(env, userId)
  const effective = effectiveScope(input.scope, userScope)
  const available: AvailableScope =
    userScope.teams.length > 0 || userScope.products.length > 0
      ? await availableScope(env, userScope)
      : { teams: [], products: [] }

  const k = input.k ?? SEARCH_K_DEFAULT
  const [hits, u] = await Promise.all([
    searchChunks(env, [input.query], { k, effective }),
    understandQuery(env, input.query, available)
  ])
  const results = await groupByDoc(env, hits)

  const interpretation: SearchInterpretation = {
    rewrittenQuery: input.query,
    expansions: [],
    suggestedFilters: buildSuggestedFilters(u.filters, available),
    llmUsed: u.llmUsed
  }
  return { results, interpretation }
}

/** Resolve the LLM's filter id guesses to {kind,id,name} chips (advisory). */
function buildSuggestedFilters(
  filters: { teams: string[]; products: string[] },
  available: AvailableScope
): SuggestedFilter[] {
  const out: SuggestedFilter[] = []
  for (const id of filters.teams) {
    const t = available.teams.find((x) => x.id === id)
    if (t) out.push({ kind: 'team', id, name: t.name })
  }
  for (const id of filters.products) {
    const p = available.products.find((x) => x.id === id)
    if (p) out.push({ kind: 'product', id, name: p.name })
  }
  return out
}

/** The caller's reachable teams/products, with display names for the LLM. */
async function availableScope(
  env: Env,
  userScope: { teams: string[]; products: string[] }
): Promise<AvailableScope> {
  const [teams, products] = await Promise.all([listTeams(env), listProducts(env)])
  const tset = new Set(userScope.teams)
  const pset = new Set(userScope.products)
  return {
    teams: teams.filter((t) => tset.has(t.id)).map((t) => ({ id: t.id, name: t.displayName })),
    products: products.filter((p) => pset.has(p.id)).map((p) => ({ id: p.id, name: p.displayName }))
  }
}

/**
 * Bucket flat hits into per-doc groups, resolving slug + title from D1.
 * Docs whose row is missing (deleted between index and now, before the
 * reindex orphan-sweep catches up) are dropped so we never link to a
 * 404. N is small (≤ k distinct docs), so per-doc lookups are fine.
 */
async function groupByDoc(env: Env, hits: SearchHit[]): Promise<SearchDocGroup[]> {
  const byDoc = new Map<string, SearchHit[]>()
  for (const h of hits) {
    const arr = byDoc.get(h.docId)
    if (arr) arr.push(h)
    else byDoc.set(h.docId, [h])
  }

  const ids = [...byDoc.keys()]
  const rows = await Promise.all(ids.map((id) => getDocById(env, id)))

  const groups: SearchDocGroup[] = []
  ids.forEach((id, i) => {
    const row = rows[i]
    if (!row) return
    const sections = (byDoc.get(id) ?? [])
      .sort((a, b) => b.score - a.score)
      .map((h) => ({
        chunkIdx: h.chunkIdx,
        headings: h.headings,
        anchor: headingAnchor(h.headings),
        snippet: h.snippet,
        score: h.score
      }))
    groups.push({
      docId: id,
      slug: row.slug,
      title: row.title,
      topScore: sections[0]?.score ?? 0,
      sections
    })
  })

  groups.sort((a, b) => b.topScore - a.topScore)
  return groups
}
