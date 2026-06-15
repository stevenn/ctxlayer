/**
 * YAML-frontmatter (de)serialiser for OKF (Open Knowledge Format) interop,
 * built on the `yaml` package's Document API. The round-trip contract is
 * *preservation*: only the well-known keys are interpreted; every other key
 * (and its comments + ordering) is carried through verbatim, because OKF
 * requires consumers to preserve unknown keys.
 *
 * We use a real YAML parser (not a hand-rolled subset) so block scalars,
 * comments, quoted/escaped strings, flow vs. block lists, and a bare scalar
 * `tags:` value all parse correctly. `splitFrontmatter` still owns the
 * `---`-fence delimiting (that's a frontmatter convention, not YAML).
 *
 * Spec: https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md
 * Reference: docs/plan/M-okf.md
 *
 * Used by both the worker (git sync import, export, write-back, reindex) and
 * the SPA import modal, so it lives in the shared package.
 */

import { Document, isMap, parse, parseDocument } from 'yaml'

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

// Canonical emit order. Also the set of keys we "manage" (a key present in the
// fields object is set/cleared; a key absent is left untouched in the raw).
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
  if (raw === null) return { raw: null, body, known: {} }
  let parsed: unknown
  try {
    parsed = parse(raw)
  } catch {
    // Malformed YAML — don't crash the import; just surface no known fields.
    parsed = null
  }
  return { raw, body, known: extractKnown(parsed) }
}

function extractKnown(obj: unknown): OkfKnownFields {
  const known: OkfKnownFields = {}
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return known
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = k.toLowerCase()
    if (key === 'tags') {
      known.tags = toStringList(v)
      continue
    }
    const s = scalar(v)
    if (s === undefined) continue
    if (key === 'title') known.title = s
    else if (key === 'type') known.type = s
    else if (key === 'description') known.description = s
    else if (key === 'resource') known.resource = s
    else if (key === 'timestamp') known.timestamp = s
  }
  return known
}

/** A scalar known-field value as a string; undefined for null / nested shapes. */
function scalar(v: unknown): string | undefined {
  if (v == null || typeof v === 'object') return undefined
  return String(v)
}

/** Coerce a `tags` value to a string list: a YAML list, or a bare scalar → [scalar]. */
function toStringList(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v
      .filter((x) => x != null && typeof x !== 'object')
      .map((x) => String(x).trim())
      .filter(Boolean)
  }
  if (v == null || typeof v === 'object') return []
  const s = String(v).trim()
  return s ? [s] : []
}

/**
 * Emit a `---`-fenced frontmatter block. Keys *present* in `fields` (even when
 * null) are "managed": set from the field value, or deleted when null/empty.
 * Keys absent from `fields` are left untouched in `rawPreserve` and carried
 * through verbatim, comments and ordering intact. Returns `''` when the
 * resulting mapping is empty.
 */
export function emitFrontmatter(fields: OkfKnownFields, rawPreserve?: string | null): string {
  const doc =
    rawPreserve && rawPreserve.trim() !== '' ? parseDocument(rawPreserve) : new Document({})
  if (!isMap(doc.contents)) doc.contents = doc.createNode({})

  for (const key of KNOWN_ORDER) {
    if (!(key in fields)) continue
    if (key === 'tags') {
      const tags = (fields.tags ?? []).map((t) => t.trim()).filter(Boolean)
      if (tags.length === 0) doc.delete('tags')
      else doc.set('tags', tags)
      continue
    }
    const value = fields[key]
    const s = value == null ? '' : String(value).replace(/[\r\n]+/g, ' ').trim()
    if (s === '') doc.delete(key)
    else doc.set(key, s)
  }

  const root = doc.contents
  if (!isMap(root) || root.items.length === 0) return ''
  // lineWidth: 0 disables line-wrapping so URLs / long values aren't folded.
  const yamlText = doc.toString({ lineWidth: 0 }).replace(/\n+$/, '')
  return `---\n${yamlText}\n---\n\n`
}
