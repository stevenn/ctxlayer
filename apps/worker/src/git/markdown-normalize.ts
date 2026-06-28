/**
 * Normalise markdown so a write-back diff reflects real edits, not the
 * BlockNote round-trip's deterministic reformatting. Applied symmetrically to
 * BOTH the synced baseline (source.md) and the editor-produced markdown before
 * diffing — and the result is what gets COMMITTED — so a no-op stays a no-op
 * AND the committed file carries conventional markdown instead of round-trip
 * noise.
 *
 * Undoes the two highest-volume transforms the BlockNote (0.51) serializer
 * applies to typical prose/table docs:
 *   - soft line-wraps re-emitted as back-slash hard breaks (`foo\` + a leading
 *     space on the continuation). Restored to plain soft breaks — which
 *     reproduces the source's ORIGINAL wrapping for every unchanged line, so a
 *     one-word edit no longer rewrites the whole paragraph.
 *   - GFM tables re-padded to per-column widths. Collapsed to a compact,
 *     stable single-space form on both sides.
 * Plus the trivial whitespace noise it always handled (CRLF, trailing spaces,
 * runs of blank lines, BOM, single trailing newline).
 *
 * Fenced code blocks pass through untouched — a trailing `\` or a `|`-row
 * inside a code sample is literal content, not markdown to reformat.
 *
 * Still lossy overall: BlockNote also flips emphasis delimiters, ATX-ifies
 * setext headings, and DROPS inline HTML. Those are lower-volume (or
 * unrecoverable) and left as residual; this targets the churn that dominates
 * a real diff.
 */
export function normalizeMarkdown(md: string): string {
  const text = md.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const lines = text.split('\n')
  const out: string[] = []
  let inFence = false
  let prevHardBreak = false
  let lastBlank = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue
    if (FENCE.test(line)) {
      inFence = !inFence
      prevHardBreak = false
      lastBlank = false
      out.push(line)
      continue
    }
    if (inFence) {
      out.push(line)
      continue
    }

    // Table block: a row containing `|` immediately followed by a separator
    // row. Recompress the whole block to a compact single-space form.
    const next = lines[i + 1]
    if (line.includes('|') && next !== undefined && isSepRow(next)) {
      const block: string[] = [line, next]
      let j = i + 2
      for (; j < lines.length; j++) {
        const r = lines[j]
        if (r === undefined || FENCE.test(r) || r.trim() === '' || !r.includes('|')) break
        block.push(r)
      }
      for (const r of recompressTable(block)) out.push(r)
      i = j - 1
      prevHardBreak = false
      lastBlank = false
      continue
    }

    // Prose line. Order: dedent a hard-break continuation, strip trailing
    // whitespace, then detect (and strip) a trailing hard-break marker.
    let cur = line
    if (prevHardBreak && cur.startsWith(' ')) cur = cur.slice(1)
    cur = cur.replace(/[ \t]+$/g, '')
    prevHardBreak = false
    const tail = cur.match(/\\+$/)
    if (tail && tail[0].length % 2 === 1) {
      cur = cur.slice(0, -1) // drop the hard-break backslash, keep the line break
      prevHardBreak = true
    }

    // Collapse runs of blank lines to a single blank line.
    if (cur.trim() === '') {
      if (lastBlank) continue
      lastBlank = true
    } else {
      lastBlank = false
    }
    out.push(cur)
  }

  const body = out.join('\n').replace(/\s+$/g, '')
  return body.length === 0 ? '' : `${body}\n`
}

const FENCE = /^\s*(`{3,}|~{3,})/

/** A GFM table separator row — must carry a pipe (so a lone `---` rule and a
 *  setext underline never read as a table) and only dash/colon cells. */
function isSepRow(line: string): boolean {
  const t = line.trim()
  if (!t.includes('|') || !t.includes('-')) return false
  const cells = t.replace(/^\|/, '').replace(/\|$/, '').split('|')
  return cells.length > 0 && cells.every((c) => /^\s*:?-+:?\s*$/.test(c))
}

/** Split a table row into trimmed cells (drops the optional outer pipes). */
function splitCells(row: string): string[] {
  let s = row.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  return s.split(/(?<!\\)\|/).map((c) => c.trim())
}

/** Render the separator cell's alignment compactly (`---` / `:--` / `--:` / `:-:`). */
function sepCell(cell: string): string {
  const t = cell.trim()
  const left = t.startsWith(':')
  const right = t.endsWith(':')
  return left && right ? ':-:' : left ? ':--' : right ? '--:' : '---'
}

/** Recompress a detected table to compact single-space-padded rows. Row 1 is
 *  the separator. */
function recompressTable(rows: string[]): string[] {
  return rows.map((row, idx) => {
    const cells = splitCells(row)
    const rendered = idx === 1 ? cells.map(sepCell) : cells
    return `| ${rendered.join(' | ')} |`
  })
}
