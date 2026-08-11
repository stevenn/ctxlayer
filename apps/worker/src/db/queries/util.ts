/**
 * Shared helpers for the D1 query modules (and the route handlers that
 * surface their errors).
 */

import { errMessage } from '../../util/errors'

/** True when a D1 error is a SQLite UNIQUE-constraint violation. */
export function isUniqueViolation(err: unknown): boolean {
  const msg = errMessage(err)
  return /UNIQUE constraint failed/i.test(msg)
}

/**
 * Build the dynamic PATCH-style `UPDATE` every query module hand-rolled:
 * skip `undefined` columns, append `updated_at = now`, bind `id` last in
 * the WHERE. Value coercions (`enabled ? 1 : 0`, JSON.stringify) stay at
 * the call site. Returns `null` when no column is set — unless
 * `allowEmpty` (docs bump `updated_at` even on an empty patch).
 * `andWhere` appends an extra predicate (e.g. `deleted_at IS NULL`).
 */
export function buildPatchUpdate(
  table: string,
  cols: Record<string, unknown>,
  id: string,
  opts?: { andWhere?: string; allowEmpty?: boolean }
): { sql: string; binds: unknown[] } | null {
  const fields: string[] = []
  const binds: unknown[] = []
  for (const [col, val] of Object.entries(cols)) {
    if (val === undefined) continue
    fields.push(`${col} = ?${fields.length + 1}`)
    binds.push(val)
  }
  if (fields.length === 0 && !opts?.allowEmpty) return null
  fields.push(`updated_at = ?${fields.length + 1}`)
  binds.push(Math.floor(Date.now() / 1000))
  binds.push(id)
  const extra = opts?.andWhere ? ` AND ${opts.andWhere}` : ''
  return {
    sql: `UPDATE ${table} SET ${fields.join(', ')} WHERE id = ?${binds.length}${extra}`,
    binds
  }
}

/**
 * Primary key for a new row: a UUIDv4 with the dashes stripped.
 *
 * Not a ULID despite the historical name in users.ts — ids are opaque and
 * never sorted on, and D1 assigns no ordering meaning to them. Every table's
 * insert path and every revision id share this one implementation so the id
 * shape can't drift per table.
 */
export function newId(): string {
  return crypto.randomUUID().replace(/-/g, '')
}

/**
 * Short random hex suffix for slug-collision retries — docs and skills
 * share the one implementation (`<base-slug>-<suffix>` on attempt > 0).
 */
export function randomSuffix(): string {
  const buf = new Uint8Array(3)
  crypto.getRandomValues(buf)
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
}
