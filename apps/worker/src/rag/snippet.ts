/**
 * Matched-span snippet selection. The reindex stores each chunk's raw body
 * (~512 tokens) in Vectorize metadata; showing its first N chars often
 * misses the part that actually matched, so a relevant hit reads as
 * irrelevant. `bestSnippet` instead centres the window on the densest
 * cluster of query terms.
 *
 * Pure + dependency-free so it's unit-tested without the worker runtime.
 * No term overlap (a purely-semantic match) → fall back to the head, which
 * is the correct behaviour for RAG (the chunk matched on meaning, not
 * words). Term scoring uses the SAME `significantTerms` the SPA highlights
 * with, so the highlighted words land inside the chosen window.
 */

/**
 * @param text   the chunk body
 * @param terms  significant query terms (lowercased; see significantTerms)
 * @param maxLen target snippet length in characters
 */
export function bestSnippet(text: string, terms: string[], maxLen: number): string {
  const clean = text.trim()
  if (clean.length <= maxLen) return clean
  if (terms.length === 0) return head(clean, maxLen)

  const lower = clean.toLowerCase()
  const positions: number[] = []
  for (const t of terms) {
    if (!t) continue
    let i = lower.indexOf(t)
    while (i !== -1) {
      positions.push(i)
      i = lower.indexOf(t, i + t.length)
    }
  }
  if (positions.length === 0) return head(clean, maxLen)
  positions.sort((a, b) => a - b)

  // Widest cluster of matches that fits within a maxLen window: slide a
  // [lo..hi] range over the sorted positions keeping (pos[hi]-pos[lo]) ≤
  // maxLen, and keep the densest one (earliest on ties).
  let bestCount = 0
  let bestAnchor = positions[0] ?? 0
  let lo = 0
  for (let hi = 0; hi < positions.length; hi++) {
    while ((positions[hi] as number) - (positions[lo] as number) > maxLen) lo++
    const count = hi - lo + 1
    if (count > bestCount) {
      bestCount = count
      bestAnchor = positions[lo] as number
    }
  }

  // Place the window: a little left-context before the first match in the
  // cluster, clamped to the text bounds, then snapped to word boundaries.
  const leftPad = Math.floor(maxLen * 0.15)
  let end = Math.min(clean.length, bestAnchor - leftPad + maxLen)
  let start = Math.max(0, end - maxLen)
  end = Math.min(clean.length, start + maxLen)

  start = snapStart(clean, start)
  end = snapEnd(clean, end)

  let snippet = clean.slice(start, end).trim()
  if (start > 0) snippet = `…${snippet}`
  if (end < clean.length) snippet = `${snippet}…`
  return snippet
}

/** First `maxLen` chars, snapped to a word boundary, with a trailing ellipsis. */
function head(text: string, maxLen: number): string {
  const end = snapEnd(text, maxLen)
  return `${text.slice(0, end).trimEnd()}…`
}

/** Nudge `start` forward to just after the previous whitespace (avoid a half word). */
function snapStart(text: string, start: number): number {
  if (start <= 0) return 0
  const ws = text.lastIndexOf(' ', start)
  // Only snap if it doesn't drop us too far back into the prior word run.
  return ws > start - 20 && ws !== -1 ? ws + 1 : start
}

/** Nudge `end` back to the previous whitespace (avoid a half word). */
function snapEnd(text: string, end: number): number {
  if (end >= text.length) return text.length
  const ws = text.lastIndexOf(' ', end)
  return ws > end - 20 && ws !== -1 ? ws : end
}
