/**
 * Detect markdown whose HTML the BlockNote round-trip would silently drop or
 * mangle — HTML comments, `<a id>` anchors, `<details>`, and styling tags
 * (`<kbd>`/`<sub>`/`<span>`/`<div align>`…). The editor's parser discards this
 * HTML on first open, so any write-back would commit it away. We BLOCK
 * write-back on such docs (edit-in-git) rather than lose content silently.
 *
 * `<br>` and `<img>` are excluded: the round-trip converts them cleanly (a line
 * break / a markdown image). Scans OUTSIDE fenced + inline code — a `<div>` in
 * a code SAMPLE is not live HTML. Angle-bracket autolinks (`<https://…>`,
 * `<a@b.com>`) are not tags (a real tag's name is followed by whitespace, `/`,
 * or `>` — not `:` or `@`), so they don't trip the guard.
 */
const SAFE_TAGS = new Set(['br', 'img'])
const TAG = /<\/?([a-zA-Z][a-zA-Z0-9-]*)(?:\s[^<>]*)?\/?>/g
const FENCE = /^\s*(`{3,}|~{3,})/

export function htmlRoundtripUnsafe(md: string): boolean {
  for (const segment of nonCodeSegments(md)) {
    if (segment.includes('<!--')) return true
    for (const m of segment.matchAll(TAG)) {
      const name = m[1]?.toLowerCase()
      if (name && !SAFE_TAGS.has(name)) return true
    }
  }
  return false
}

/** Prose runs with fenced code blocks removed and inline code spans blanked. */
function nonCodeSegments(md: string): string[] {
  const lines = md.replace(/\r\n?/g, '\n').split('\n')
  const segments: string[] = []
  let buf: string[] = []
  let inFence = false
  for (const line of lines) {
    if (FENCE.test(line)) {
      if (!inFence) {
        segments.push(buf.join('\n'))
        buf = []
      }
      inFence = !inFence
      continue
    }
    if (!inFence) buf.push(line)
  }
  segments.push(buf.join('\n'))
  return segments.map((s) => s.replace(/`[^`]*`/g, ' '))
}
