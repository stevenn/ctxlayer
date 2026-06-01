/**
 * Helpers that enrich the draft-context bundle with RAG-grounded
 * `relatedDocs` and `usageAggregates` for the (user, upstream, tool)
 * slice. Both are best-effort — failures degrade to empty/null so the
 * draft still proceeds even if Vectorize / D1 hiccup.
 */

import type { Env } from '../env'
import type { DraftContextBundle } from '@ctxlayer/shared'
import { mangleToolName } from '@ctxlayer/shared'
import { embed } from '../rag/embedder'
import type { ChunkMetadata } from '../rag/index'
import { getUpstreamUsageRollup } from '../db/queries/usage-read'

const RELATED_DOCS_K = 3
const RELATED_DOCS_SNIPPET = 500
const USAGE_LOOKBACK_DAYS = 30
const SECONDS_PER_DAY = 86400

/**
 * Top-k chunks mentioning the upstream slug (+ tool name when
 * provided). Scope-agnostic — drafting is admin-only, so we don't
 * filter by team/product. Returns empty on any failure (Vectorize is
 * eventually-consistent; a draft is too early to insist on RAG).
 */
export async function findRelatedDocs(
  env: Env,
  args: { upstreamSlug: string; toolName?: string }
): Promise<DraftContextBundle['relatedDocs']> {
  try {
    const query = [args.upstreamSlug, args.toolName].filter(Boolean).join(' ').trim()
    if (!query) return []
    const { vectors } = await embed(env, [query])
    const qvec = vectors[0]
    if (!qvec) return []
    const result = await env.DOCS_INDEX.query(qvec, {
      topK: RELATED_DOCS_K,
      returnMetadata: 'all'
    })
    const out: DraftContextBundle['relatedDocs'] = []
    for (const m of result.matches ?? []) {
      const meta = m.metadata as unknown as ChunkMetadata | undefined
      if (!meta) continue
      out.push({
        slug: meta.docId,
        title: meta.title,
        excerpt: truncate(meta.text ?? '', RELATED_DOCS_SNIPPET),
        relevanceScore: m.score
      })
    }
    return out
  } catch (err) {
    console.warn(
      'draft-context: findRelatedDocs failed (non-fatal):',
      err instanceof Error ? err.message : String(err)
    )
    return []
  }
}

/**
 * Per-(user, upstream, tool) call counts over the last 30 days, plus a
 * daily breakdown. Tool name is the mangled form persisted in
 * usage_rollups_daily (the same string the agent sees over MCP).
 *
 * Returns null when the requested slice has zero events — keeps the
 * bundle shape stable and signals to the drafter "no behavioural
 * signal for this tool".
 */
export async function buildUsageAggregates(
  env: Env,
  args: { userId: string; upstreamId: string; upstreamSlug: string; toolName?: string }
): Promise<DraftContextBundle['usageAggregates']> {
  try {
    const now = Math.floor(Date.now() / 1000)
    const earliestDay =
      Math.floor((now - USAGE_LOOKBACK_DAYS * SECONDS_PER_DAY) / SECONDS_PER_DAY) * SECONDS_PER_DAY

    // tool name is mangled in usage_rollups_daily; if no specific tool,
    // sum across all tools on the upstream.
    const mangled = args.toolName ? mangleToolName(args.upstreamSlug, args.toolName) : null

    const { totalCalls, byDay } = await getUpstreamUsageRollup(env, {
      userId: args.userId,
      upstreamId: args.upstreamId,
      sinceDay: earliestDay,
      mangledTool: mangled
    })
    if (totalCalls === 0) return null

    const callsByDay = byDay.map((r) => ({
      day: new Date(r.day * 1000).toISOString().slice(0, 10),
      count: r.calls
    }))

    // topArgPatterns: deferred — usage_events doesn't capture req
    // payloads (only sizes), so there's nothing to pattern-match on.
    return { totalCalls, callsByDay, topArgPatterns: [] }
  } catch (err) {
    console.warn(
      'draft-context: buildUsageAggregates failed (non-fatal):',
      err instanceof Error ? err.message : String(err)
    )
    return null
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n - 1) + '…'
}
