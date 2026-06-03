/**
 * Query term extraction, shared server↔client so the snippet the server
 * centers on (rag/snippet.ts) and the terms the SPA highlights
 * (<Highlighted> in doc-search.tsx) are derived the same way — otherwise
 * the highlighted words can fall outside the chosen snippet window.
 */

// Common English function words that carry no retrieval signal. Kept small
// and deliberately conservative — over-stripping hurts more than a couple
// of stopwords slipping through.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'how', 'does', 'what', 'are', 'you', 'your',
  'from', 'that', 'this', 'into', 'can', 'will', 'when', 'where', 'which',
  'was', 'has', 'have', 'about', 'why', 'who'
])

/**
 * Significant lowercased terms from a query: alphanumeric runs ≥3 chars,
 * minus stopwords, deduped. Used to highlight + to score snippet windows.
 */
export function significantTerms(query: string): string[] {
  const words = query.toLowerCase().match(/[a-z0-9]+/g) ?? []
  return [...new Set(words.filter((w) => w.length >= 3 && !STOPWORDS.has(w)))]
}

/** Escape a string for safe use inside a RegExp. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
