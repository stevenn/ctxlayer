import type { AuditLogEntry, AuditLogResponse } from '@ctxlayer/shared'
import type { Env } from '../../env'

/**
 * Append one row to `audit_log`. Pure persistence — id/ts generation,
 * meta serialisation, and the best-effort error swallowing live in the
 * semantic wrapper `audit/log.ts` (`audit()`), which is what callers
 * should use.
 */
export interface InsertAuditRow {
  id: string
  ts: number
  actorId: string
  action: string
  target: string | null
  meta: string | null
}

export async function insertAuditRow(env: Env, row: InsertAuditRow): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_log (id, ts, actor_id, action, target, meta)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
  )
    .bind(row.id, row.ts, row.actorId, row.action, row.target, row.meta)
    .run()
}

/**
 * Read the audit log, newest first. Cursor pagination keyed on `ts`
 * — pass `before` to fetch the page older than that timestamp. The
 * `nextBefore` returned in the response is the oldest `ts` on the
 * current page, or `null` when fewer than `limit` rows came back
 * (indicating no further pages).
 *
 * `actionPrefix` does a `LIKE 'prefix%'` so callers can filter to a
 * family like `doc.` or `user.`. `actor` matches the actor id exactly
 * OR the actor's email as a case-insensitive substring — the viewer's
 * Actor column DISPLAYS the email, so an exact-id-only filter read as
 * broken to anyone pasting what they saw (2026-08-28 report). Filters
 * AND together.
 */
export interface ListAuditOpts {
  limit: number
  before?: number
  actionPrefix?: string
  actor?: string
}

type Row = {
  id: string
  ts: number
  actor_id: string | null
  actor_email: string | null
  action: string
  target: string | null
  meta: string | null
}

export async function listAuditEntries(env: Env, opts: ListAuditOpts): Promise<AuditLogResponse> {
  const where: string[] = []
  const binds: unknown[] = []

  if (opts.before !== undefined) {
    where.push(`a.ts < ?`)
    binds.push(opts.before)
  }
  if (opts.actionPrefix) {
    // SQLite LIKE is case-insensitive for ASCII by default; action
    // strings are dotted lowercase by convention so that's fine.
    where.push(`a.action LIKE ?`)
    binds.push(`${opts.actionPrefix}%`)
  }
  if (opts.actor) {
    // Escape LIKE wildcards so a literal % / _ in the filter can't match
    // everything; the id side stays an exact compare.
    const escaped = opts.actor.replace(/[\\%_]/g, (ch) => `\\${ch}`)
    where.push(`(a.actor_id = ? OR u.email LIKE ? ESCAPE '\\')`)
    binds.push(opts.actor, `%${escaped}%`)
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

  // LEFT JOIN so entries whose actor was later deleted still appear
  // (the user row would be gone, but the log row stands on its own).
  const sql = `
    SELECT a.id, a.ts, a.actor_id, u.email AS actor_email,
           a.action, a.target, a.meta
    FROM audit_log a
    LEFT JOIN users u ON u.id = a.actor_id
    ${whereSql}
    ORDER BY a.ts DESC, a.id DESC
    LIMIT ?
  `
  const { results } = await env.DB.prepare(sql)
    .bind(...binds, opts.limit)
    .all<Row>()

  const entries: AuditLogEntry[] = (results ?? []).map((r) => ({
    id: r.id,
    ts: r.ts,
    actorId: r.actor_id,
    actorEmail: r.actor_email,
    action: r.action,
    target: r.target,
    meta: r.meta ? safeParse(r.meta) : null
  }))

  // nextBefore = oldest ts on this page, but only if we filled the
  // window — otherwise we've reached the tail.
  const nextBefore = entries.length === opts.limit ? entries[entries.length - 1]!.ts : null

  return { entries, nextBefore }
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return s
  }
}
