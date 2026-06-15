/**
 * Minimal YAML-frontmatter (de)serialiser for OKF (Open Knowledge Format)
 * interop. OKF frontmatter is shallow — a handful of scalar fields plus a
 * `tags` list — so we parse a flat subset by hand rather than pull a YAML
 * dependency. The contract that makes round-tripping safe is *preservation*:
 * we only interpret the well-known keys; every other key in the block is
 * carried through verbatim, because OKF requires consumers to preserve
 * unknown keys.
 *
 * Spec: https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md
 * Reference: docs/plan/M-okf.md
 *
 * Used by both the worker (git sync import, export, write-back, reindex) and
 * the SPA import modal, so it lives in the shared package.
 */

/** The OKF-recommended fields ctxlayer projects onto the doc rail. */
export interface OkfKnownFields {
  title?: string | null
  type?: string | null
  description?: string | null
  resource?: string | null
  tags?: string[]
  timestamp?: string | null
}

export interface ParsedFrontmatter {
  /** Raw YAML block between the `---` fences (no fences), or null if absent. */
  raw: string | null
  /** The markdown body with the frontmatter block removed. */
  body: string
  /** Best-effort parse of the well-known fields. */
  known: OkfKnownFields
}

// Canonical emit order. Also the set of keys we "manage" (strip from the
// preserved remainder when present in the fields object).
const KNOWN_ORDER = ['type', 'title', 'description', 'resource', 'tags', 'timestamp'] as const

// Leading frontmatter fence: `---`, the block, closing `---`. (A leading BOM
// is stripped before this runs.)
const FENCE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

/** Split a document into its frontmatter block (raw, no fences) and body. */
export function splitFrontmatter(text: string): { raw: string | null; body: string } {
  // Tolerate a leading UTF-8 BOM (common on Windows-authored files).
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const m = FENCE.exec(s)
  if (!m) return { raw: null, body: text }
  // Drop the blank line(s) separating the closing fence from the body.
  return { raw: m[1] ?? '', body: s.slice(m[0].length).replace(/^\n+/, '') }
}

/** Split + parse the well-known fields out of a document's frontmatter. */
export function parseFrontmatter(text: string): ParsedFrontmatter {
  const { raw, body } = splitFrontmatter(text)
  return { raw, body, known: raw === null ? {} : parseKnownFields(raw) }
}

function parseKnownFields(raw: string): OkfKnownFields {
  const lines = raw.split(/\r?\n/)
  const known: OkfKnownFields = {}
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (/^\s/.test(line)) continue // not a top-level key
    const m = /^([A-Za-z0-9_.-]+)\s*:\s?(.*)$/.exec(line)
    if (!m) continue
    const key = (m[1] ?? '').toLowerCase()
    const rest = m[2] ?? ''
    if (key === 'title') known.title = unquote(rest)
    else if (key === 'type') known.type = unquote(rest)
    else if (key === 'description') known.description = unquote(rest)
    else if (key === 'resource') known.resource = unquote(rest)
    else if (key === 'timestamp') known.timestamp = unquote(rest)
    else if (key === 'tags') {
      if (rest.trim().startsWith('[')) {
        known.tags = parseInlineList(rest.trim())
      } else {
        const tags: string[] = []
        let j = i + 1
        for (; j < lines.length && /^\s*-\s+/.test(lines[j] ?? ''); j++) {
          const item = unquote((lines[j] ?? '').replace(/^\s*-\s+/, ''))
          if (item) tags.push(item)
        }
        known.tags = tags
      }
    }
  }
  return known
}

/**
 * Emit a `---`-fenced frontmatter block. Keys *present* in `fields` (even when
 * null) are "managed": stripped from `rawPreserve` and re-emitted from the
 * field value (null/empty → omitted entirely). Keys absent from `fields` are
 * left untouched in `rawPreserve` and carried through verbatim. Returns `''`
 * when there's nothing at all to emit.
 */
export function emitFrontmatter(fields: OkfKnownFields, rawPreserve?: string | null): string {
  const managed = new Set<string>(KNOWN_ORDER.filter((k) => k in fields))
  const preserved = rawPreserve ? stripManagedKeys(rawPreserve, managed) : ''

  const lines: string[] = []
  for (const key of KNOWN_ORDER) {
    if (!(key in fields)) continue
    if (key === 'tags') {
      const tags = (fields.tags ?? []).map((t) => t.trim()).filter(Boolean)
      if (tags.length === 0) continue
      lines.push('tags:')
      for (const t of tags) lines.push(`  - ${emitScalar(t)}`)
      continue
    }
    const value = fields[key]
    if (value == null) continue
    const s = String(value).replace(/[\r\n]+/g, ' ').trim()
    if (s === '') continue
    lines.push(`${key}: ${emitScalar(s)}`)
  }

  const all = [...lines, ...(preserved ? [preserved] : [])]
  if (all.length === 0) return ''
  return `---\n${all.join('\n')}\n---\n\n`
}

/** Drop the top-level managed keys (and their indented continuations). */
function stripManagedKeys(raw: string, managed: Set<string>): string {
  const lines = raw.split(/\r?\n/)
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    const m = /^([A-Za-z0-9_.-]+)\s*:/.exec(line)
    if (m && !/^\s/.test(line)) {
      const key = (m[1] ?? '').toLowerCase()
      const block = [line]
      i++
      // Consume indented continuation lines (list items / block scalars).
      for (; i < lines.length && /^\s+\S/.test(lines[i] ?? ''); i++) block.push(lines[i] ?? '')
      if (!managed.has(key)) out.push(...block)
    } else {
      out.push(line)
      i++
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

function emitScalar(value: string): string {
  return needsQuote(value) ? JSON.stringify(value) : value
}

function needsQuote(s: string): boolean {
  if (s === '') return true
  if (/[:#[\]{}&*!|>'"%@`,]/.test(s)) return true
  if (/^[\s?-]/.test(s) || /\s$/.test(s)) return true
  if (/^(true|false|null|yes|no|on|off|~)$/i.test(s)) return true
  if (/^[-+]?[\d.]/.test(s)) return true
  return false
}

function unquote(s: string): string {
  const t = s.trim()
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    try {
      return JSON.parse(t)
    } catch {
      return t.slice(1, -1)
    }
  }
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'")
  return t
}

function parseInlineList(s: string): string[] {
  return s
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((x) => unquote(x.trim()))
    .filter(Boolean)
}
