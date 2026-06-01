/**
 * Schema diff helpers for M8 catalogue staleness tracking.
 *
 * The refresh path calls `canonicalHash()` on each incoming tool's
 * inputSchema and compares against the previously cached hash. If
 * different, persist the new hash + bump `last_schema_change_at` +
 * write a short human-readable `last_diff_summary`.
 *
 * Goal: only changes that genuinely affect the agent's *contract*
 * with the tool should trip the hash. Cosmetic edits to descriptions,
 * key reorderings, and semantically-equal alternative encodings
 * (`type: 'X'` vs `['X']`) MUST hash the same — otherwise admins get
 * spurious "schema changed" warnings on every documentation tweak.
 */

/**
 * Fields that don't affect what data the tool accepts/returns. Removed
 * before hashing so a description rewording doesn't trip the diff.
 * `default` stays — even though it doesn't affect *validation*, it
 * affects observed agent behaviour (the agent might assume the
 * default's value), so a default change is contractually meaningful.
 */
const COSMETIC_KEYS = new Set([
  'title',
  'description',
  'examples',
  'example',
  '$comment',
  '$id',
  '$schema',
  'readOnly',
  'writeOnly',
  'deprecated',
  'markdownDescription'
])

/**
 * JSON-Schema fields whose elements form a set (order is semantically
 * irrelevant). Sorted before hashing so `required: ['a','b']` and
 * `required: ['b','a']` produce identical hashes.
 */
const SET_LIKE_ARRAYS = new Set(['required', 'enum'])

export async function canonicalHash(schema: unknown): Promise<string> {
  const canon = canonicalise(schema)
  const bytes = new TextEncoder().encode(canon)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const view = new Uint8Array(digest)
  let hex = ''
  for (const b of view) hex += b.toString(16).padStart(2, '0')
  return hex
}

/**
 * Recursively canonicalise a JSON-Schema-ish value into a stable
 * string. Visible for testing.
 */
export function canonicalise(v: unknown, parentKey?: string): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) {
    // Sort set-like arrays so element reordering doesn't trip the hash.
    const items = parentKey && SET_LIKE_ARRAYS.has(parentKey) ? [...v].sort(stableCompare) : v
    return '[' + items.map((x) => canonicalise(x)).join(',') + ']'
  }
  const obj = v as Record<string, unknown>
  // 1. Drop cosmetic keys.
  // 2. Normalize `type: ['X']` → `type: 'X'` (single-element type arrays
  //    are JSON-Schema-equivalent to bare strings; presenting them
  //    differently is just an encoding choice).
  const entries: Array<[string, unknown]> = []
  for (const [k, raw] of Object.entries(obj)) {
    if (COSMETIC_KEYS.has(k)) continue
    let val: unknown = raw
    if (k === 'type' && Array.isArray(raw) && raw.length === 1) {
      val = raw[0]
    }
    entries.push([k, val])
  }
  // 3. Sort keys for deterministic ordering.
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return (
    '{' + entries.map(([k, val]) => JSON.stringify(k) + ':' + canonicalise(val, k)).join(',') + '}'
  )
}

function stableCompare(a: unknown, b: unknown): number {
  const as = canonicalise(a)
  const bs = canonicalise(b)
  return as < bs ? -1 : as > bs ? 1 : 0
}

/**
 * Best-effort diff summary between old + new JSON-Schema objects. Not
 * a full structural diff — just the two most-load-bearing changes
 * (required-set delta + property-set delta) since those drive whether
 * an attached skill genuinely needs review.
 */
export function summariseDiff(oldSchema: unknown, newSchema: unknown): string {
  const parts: string[] = []
  const oldProps = propsOf(oldSchema)
  const newProps = propsOf(newSchema)
  const addedProps = [...newProps].filter((p) => !oldProps.has(p))
  const removedProps = [...oldProps].filter((p) => !newProps.has(p))
  if (addedProps.length) parts.push(`+props: ${addedProps.join(', ')}`)
  if (removedProps.length) parts.push(`-props: ${removedProps.join(', ')}`)

  const oldReq = requiredOf(oldSchema)
  const newReq = requiredOf(newSchema)
  const addedReq = [...newReq].filter((r) => !oldReq.has(r))
  const removedReq = [...oldReq].filter((r) => !newReq.has(r))
  if (addedReq.length) parts.push(`+required: ${addedReq.join(', ')}`)
  if (removedReq.length) parts.push(`-required: ${removedReq.join(', ')}`)

  if (parts.length === 0) return 'schema changed (no top-level prop/required delta)'
  return parts.join('; ').slice(0, 500)
}

function propsOf(schema: unknown): Set<string> {
  if (!schema || typeof schema !== 'object') return new Set()
  const props = (schema as { properties?: unknown }).properties
  if (!props || typeof props !== 'object') return new Set()
  return new Set(Object.keys(props))
}

function requiredOf(schema: unknown): Set<string> {
  if (!schema || typeof schema !== 'object') return new Set()
  const req = (schema as { required?: unknown }).required
  if (!Array.isArray(req)) return new Set()
  return new Set(req.filter((x): x is string => typeof x === 'string'))
}
