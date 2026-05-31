import { z } from 'zod'
import { SearchScope } from './org-ia'

// `SearchScope` (the `'all'` | { teams?, products? } filter) is shared
// with the MCP `search_docs` tool and defined once in org-ia.ts.

export const SearchRequest = z.object({
  query: z.string().min(1).max(512),
  // Number of doc/section hits to return. Server clamps + defaults.
  k: z.number().int().min(1).max(50).optional(),
  scope: SearchScope.optional()
})
export type SearchRequest = z.infer<typeof SearchRequest>

// One matching chunk within a doc. `anchor` is the slugified heading
// path (see headingAnchor) the editor scrolls to via ?section=.
export const SearchSectionHit = z.object({
  chunkIdx: z.number().int().min(0),
  // h1..h3 active at the chunk start, top-down. May be empty (or just
  // [title]) for pre-heading chunks.
  headings: z.array(z.string()),
  anchor: z.string(),
  snippet: z.string(),
  score: z.number()
})
export type SearchSectionHit = z.infer<typeof SearchSectionHit>

// Results are grouped by doc — one card per doc, strongest section
// first — which is the homepage UX. `topScore` orders the groups.
export const SearchDocGroup = z.object({
  docId: z.string(),
  slug: z.string(),
  title: z.string(),
  topScore: z.number(),
  sections: z.array(SearchSectionHit)
})
export type SearchDocGroup = z.infer<typeof SearchDocGroup>

// A team/product the LLM thinks the query is about. Advisory only —
// shown as a clickable chip that re-scopes the search; never applied
// automatically.
export const SuggestedFilter = z.object({
  kind: z.enum(['team', 'product']),
  id: z.string(),
  name: z.string()
})
export type SuggestedFilter = z.infer<typeof SuggestedFilter>

// What the query-understanding step produced. The query is embedded
// verbatim (no auto-rewrite/expansion applied to retrieval); the LLM's
// only effect on results is the optional `suggestedFilters` the user
// can click. `llmUsed=false` when the LLM was skipped or fell back.
export const SearchInterpretation = z.object({
  rewrittenQuery: z.string(),
  expansions: z.array(z.string()).optional(),
  suggestedFilters: z.array(SuggestedFilter).optional(),
  llmUsed: z.boolean()
})
export type SearchInterpretation = z.infer<typeof SearchInterpretation>

export const SearchResponse = z.object({
  results: z.array(SearchDocGroup),
  interpretation: SearchInterpretation
})
export type SearchResponse = z.infer<typeof SearchResponse>

// ----- heading anchors (shared server↔client) ----------------------------
//
// The reindex pipeline stores heading *text* (not block ids), so deep
// links are heading-path-based. Both the server (anchor generation in
// search results) and the client (matching against the live block tree
// in the editor) must agree on the slug, so the helper lives here.

export function slugifyHeading(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[`*_~]/g, '') // strip markdown emphasis / code marks
    .replace(/[^a-z0-9]+/g, '-') // any run of non-alphanumerics → single dash
    .replace(/^-+|-+$/g, '') // trim leading / trailing dashes
}

export function headingAnchor(headings: string[]): string {
  return headings.map(slugifyHeading).filter(Boolean).join('/')
}
