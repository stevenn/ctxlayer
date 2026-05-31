/**
 * Normalise markdown so a write-back diff reflects real edits, not
 * formatting churn. Applied to BOTH the synced baseline and the
 * editor-produced markdown before comparing / committing: CRLF→LF,
 * strip trailing whitespace, collapse 3+ blank lines, single trailing
 * newline, drop a leading BOM.
 *
 * The BlockNote round-trip is lossy, so this can't make the diff
 * perfect — it just removes the trivial, deterministic noise.
 */
export function normalizeMarkdown(md: string): string {
  const body = md
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+$/g, '')
  return body.length === 0 ? '' : `${body}\n`
}
