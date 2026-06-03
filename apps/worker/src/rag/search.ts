/**
 * Shared semantic-search core behind both the MCP `search_docs` tool and
 * the REST `POST /api/search` endpoint, so the two never drift.
 *
 * Pipeline (both entry points):
 *   understandQuery (LLM, cached, best-effort)
 *     → multi-query dense recall (rewritten + expansions, bge query-instruction)
 *     → merge + scope-filter                          [retrieveCandidates]
 *     → cross-encoder rerank (bge-reranker-base)       [rerankCandidates]
 *     → rerank-score floor + top-k + matched-span snippet
 *
 * `searchDocs` is the orchestrator; `retrieveCandidates` is the dense
 * primitive (candidate generation only — no final slice/snippet, so the
 * reranker can slot in after it). The reranker is best-effort: on any
 * failure the result falls back to dense order, so search never errors on
 * it.
 */

import type { Env } from '../env'
import type { ChunkMetadata } from './index'
import type {
  SearchDocGroup,
  SearchInterpretation,
  SearchResponse,
  SearchScope
} from '@ctxlayer/shared'
import { headingAnchor, significantTerms } from '@ctxlayer/shared'
import type { SuggestedFilter } from '@ctxlayer/shared'
import { embedQueries } from './embedder'
import { bestSnippet } from './snippet'
import { rerankCandidates, type Candidate } from './reranker'
import { isLocalRemoteBindingError } from './ai-util'
import {
  understandQuery,
  type AvailableScope,
  type QueryUnderstanding
} from './query-understanding'
import { resolveUserScope } from '../db/queries/doc-tags'
import { getDocById, gitDocIdsAmong } from '../db/queries/docs'
import { listTeams } from '../db/queries/teams'
import { listProducts } from '../db/queries/products'

export const SEARCH_K_DEFAULT = 8
export const SEARCH_K_MAX = 50

// Dense queries fed to the reranker (rewritten + expansions + raw, deduped).
const MAX_QUERIES = 4
// Candidates fed to the cross-encoder. Vectorize caps topK at 50 when
// `returnMetadata: 'all'` (which we always pass), so this is also the cap.
const RERANK_CANDIDATES = 40
const VECTORIZE_TOPK_MAX = 50
// Low prefilter on dense candidates — just keeps obvious garbage out of the
// reranker. Replaces the old blunt 0.5 floor (the reranker now does the
// real relevance gating).
const CANDIDATE_FLOOR = 0.3
// Final gate on the reranker's sigmoid score. 0.5 is the neutral decision
// boundary (logit ≥ 0 → "more relevant than not"). Tuned up from an initial
// permissive 0.15 after observing live distributions: bge-reranker-base
// emits small-magnitude logits on long code/doc passages, so scores cluster
// just above 0.5 and a higher floor would clip relevant borderline hits.
const RERANK_FLOOR = 0.5
// When the reranker is unavailable (dev / failure) we fall back to dense
// order and gate on cosine, preserving the pre-rerank behaviour.
const DENSE_FALLBACK_FLOOR = 0.5
const SNIPPET_MAX = 400

/** A single matching chunk, scope-filtered and ready to return. */
export interface SearchHit {
  docId: string
  chunkIdx: number
  title: string
  headings: string[]
  /** Dense cosine similarity. */
  score: number
  /** Cross-encoder relevance in [0,1]; absent on dense fallback. */
  rerankScore?: number
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

/** Trim, drop empties, dedupe case-insensitively, preserve order, cap. */
function dedupeQueries(queries: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const q of queries) {
    const trimmed = q.trim()
    if (!trimmed) continue
    const key = trimmed.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(trimmed)
  }
  return out.slice(0, MAX_QUERIES)
}

/**
 * Dense candidate generation: embed the query set (with the bge query
 * instruction), query Vectorize for each, merge by chunk id keeping the
 * best cosine, scope-filter (git docs bypass), low-floor, and return up to
 * `limit` candidates sorted by cosine. No final slice/snippet here — the
 * reranker takes it from these.
 */
export async function retrieveCandidates(
  env: Env,
  queries: string[],
  opts: { effective: EffectiveScope; limit?: number }
): Promise<Candidate[]> {
  const cleaned = queries.map((q) => q.trim()).filter(Boolean)
  if (cleaned.length === 0) return []

  const limit = opts.limit ?? RERANK_CANDIDATES
  const topK = Math.min(limit, VECTORIZE_TOPK_MAX)

  // Workers AI + Vectorize don't run under a plain `wrangler dev` (they
  // throw "needs to be run remotely"); locally there are no vectors anyway,
  // so degrade to empty results instead of a 500. Real errors propagate.
  let results: Awaited<ReturnType<typeof env.DOCS_INDEX.query>>[]
  try {
    const { vectors } = await embedQueries(env, cleaned)
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

  // Merge across queries by chunk id, keeping the best cosine (scope is
  // applied below, not here, so git docs can bypass it).
  const best = new Map<string, { metadata: ChunkMetadata; score: number }>()
  for (const result of results) {
    for (const m of result.matches ?? []) {
      const metadata = m.metadata as unknown as ChunkMetadata
      const id = `${metadata.docId}:${metadata.chunkIdx}`
      const prev = best.get(id)
      if (!prev || m.score > prev.score) best.set(id, { metadata, score: m.score })
    }
  }

  const merged = [...best.values()]
  // Git-synced docs are always searchable regardless of their team/product
  // tag (the tag organizes, it doesn't gate search).
  const gitDocIds = await gitDocIdsAmong(env, [...new Set(merged.map((c) => c.metadata.docId))])

  return merged
    .filter((c) => gitDocIds.has(c.metadata.docId) || passesScope(c.metadata, opts.effective))
    .filter((c) => c.score >= CANDIDATE_FLOOR)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((c) => ({ metadata: c.metadata, denseScore: c.score }))
}

/** Candidate → SearchHit, attaching the matched-span snippet. */
function toHit(c: Candidate, rerankScore: number | undefined, terms: string[]): SearchHit {
  return {
    docId: c.metadata.docId,
    chunkIdx: c.metadata.chunkIdx,
    title: c.metadata.title,
    headings: c.metadata.headings,
    score: c.denseScore,
    rerankScore,
    snippet: bestSnippet(c.metadata.text, terms, SNIPPET_MAX)
  }
}

export interface SearchDocsInput {
  query: string
  k: number
  effective: EffectiveScope
  available: AvailableScope
}

/**
 * Full retrieval chain shared by both entry points. Returns the ranked
 * hits plus the query interpretation (so the REST layer can surface the
 * real rewrite/expansions/filters).
 */
export async function searchDocs(
  env: Env,
  input: SearchDocsInput
): Promise<{ hits: SearchHit[]; interpretation: QueryUnderstanding }> {
  const u = await understandQuery(env, input.query, input.available)
  const queries = dedupeQueries([u.rewrittenQuery, ...u.expansions, input.query])
  const candidates = await retrieveCandidates(env, queries, { effective: input.effective })
  if (candidates.length === 0) return { hits: [], interpretation: u }

  // Rerank against the RAW query — cross-encoders handle natural language
  // better than the keyword rewrite (which is for dense recall).
  const terms = significantTerms(input.query)
  const reranked = await rerankCandidates(env, input.query, candidates, {
    k: input.k,
    floor: RERANK_FLOOR
  })

  const hits =
    reranked === null
      ? candidates
          .filter((c) => c.denseScore >= DENSE_FALLBACK_FLOOR)
          .slice(0, input.k)
          .map((c) => toHit(c, undefined, terms))
      : reranked.map((r) => toHit(r.candidate, r.rerankScore, terms))

  return { hits, interpretation: u }
}

export interface RunSearchInput {
  query: string
  k?: number
  scope?: SearchScope
}

/**
 * REST orchestrator. Resolves the caller's scope, runs the shared
 * `searchDocs` chain, groups hits by doc, and wraps them in the
 * interpretation envelope the SPA renders.
 */
export async function runSearch(
  env: Env,
  userId: string,
  input: RunSearchInput
): Promise<SearchResponse> {
  const userScope = await resolveUserScope(env, userId)
  const effective = effectiveScope(input.scope, userScope)
  const available = await availableScopeFor(env, userScope)

  const k = input.k ?? SEARCH_K_DEFAULT
  const { hits, interpretation: u } = await searchDocs(env, {
    query: input.query,
    k,
    effective,
    available
  })
  const results = await groupByDoc(env, hits)

  const interpretation: SearchInterpretation = {
    rewrittenQuery: u.rewrittenQuery,
    expansions: u.expansions,
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

/**
 * The caller's reachable teams/products with display names, for the LLM +
 * the suggested-filter chips. Empty (no LLM scope hint) when the caller
 * belongs to nothing. Exported so the MCP `search_docs` tool builds the
 * same `available` scope the REST path does.
 */
export async function availableScopeFor(
  env: Env,
  userScope: { teams: string[]; products: string[] }
): Promise<AvailableScope> {
  if (userScope.teams.length === 0 && userScope.products.length === 0) {
    return { teams: [], products: [] }
  }
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
 * Ordering uses `rerankScore ?? score` so the reranker's ordering carries
 * through to the section + group sort. Docs whose row is missing (deleted
 * between index and now) are dropped so we never link to a 404.
 */
async function groupByDoc(env: Env, hits: SearchHit[]): Promise<SearchDocGroup[]> {
  const rank = (h: SearchHit): number => h.rerankScore ?? h.score
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
      .sort((a, b) => rank(b) - rank(a))
      .map((h) => ({
        chunkIdx: h.chunkIdx,
        headings: h.headings,
        anchor: headingAnchor(h.headings),
        snippet: h.snippet,
        score: h.score,
        rerankScore: h.rerankScore
      }))
    groups.push({
      docId: id,
      slug: row.slug,
      title: row.title,
      topScore: sections[0] ? (sections[0].rerankScore ?? sections[0].score) : 0,
      sections
    })
  })

  groups.sort((a, b) => b.topScore - a.topScore)
  return groups
}
