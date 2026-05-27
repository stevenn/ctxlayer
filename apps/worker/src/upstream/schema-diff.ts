/**
 * Schema diff helpers for M8 catalogue staleness tracking.
 *
 * The refresh path calls `canonicalHash()` on each incoming tool's
 * inputSchema and compares against the previously cached hash. If
 * different, persist the new hash + bump `last_schema_change_at` +
 * write a short human-readable `last_diff_summary`.
 *
 * Canonicalisation = JSON.stringify with sorted keys, so semantically-
 * equal schemas with reshuffled keys don't trigger spurious diffs.
 */

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
 * Stringified-with-sorted-keys variant of JSON.stringify. Stable
 * across key ordering. Arrays preserve order (which is semantically
 * significant in JSON-Schema's `required` array; preserving order
 * means added/removed entries are detected by hash change).
 */
function canonicalise(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(canonicalise).join(',') + ']'
  const obj = v as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalise(obj[k])).join(',') + '}'
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
