/**
 * Single source of truth for doc metadata length limits. Every write path —
 * the create/update request schemas (modal + REST), git-sync import, and the
 * tag-write path — clamps to these, so a value that lands in the DB always
 * satisfies the rail-edit limits (no "synced doc can't be re-saved" drift).
 *
 * Behaviour is uniform: over-limit values are TRUNCATED, not rejected, so a
 * valid OKF file never fails to import on length. `frontmatter` is the one
 * exception — the raw block can't be truncated without corrupting the YAML,
 * so an over-limit block is dropped (unknown-key preservation is skipped for
 * that doc) rather than cut mid-key.
 */
export const DOC_LIMITS = {
  title: 200,
  type: 120,
  description: 2000,
  resource: 2000,
  /** Per-tag character cap. */
  tag: 96,
  /** Max tags per doc. */
  tagCount: 50,
  /** Raw OKF frontmatter block (stored verbatim for round-trip). */
  frontmatter: 32000
} as const

/** Truncate a string to `max` characters (length-only clamp). */
export function clampText(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s
}

/**
 * Normalise a free-form tag list: trim + collapse internal whitespace, cap
 * each tag's length, cap the count, and dedup case-insensitively (keeping the
 * first-seen casing). Tags are stored verbatim — no slugging — so they
 * round-trip to OKF frontmatter `tags` intact.
 */
export function clampTags(tags: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of tags) {
    const value = raw.trim().replace(/\s+/g, ' ').slice(0, DOC_LIMITS.tag)
    const key = value.toLowerCase()
    if (!value || seen.has(key)) continue
    seen.add(key)
    out.push(value)
    if (out.length >= DOC_LIMITS.tagCount) break
  }
  return out
}
