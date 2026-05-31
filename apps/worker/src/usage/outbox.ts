/**
 * Durable usage outbox, backed by the McpSessionDO's own SQLite.
 *
 * Tool calls stage a pre-computed `UsageEventMsg` here synchronously
 * (in-invocation, durable immediately), and `McpSessionDO.flushUsageOutbox`
 * — fired on a DO alarm — drains staged rows to `USAGE_QUEUE` in its own
 * invocation with a clean budget.
 *
 * This replaces the old `recordUsage` → `ctx.waitUntil(queue.send)` path,
 * whose backgrounded send could be cancelled once a streaming `/mcp`
 * response ended ("waitUntil() tasks did not complete within the allowed
 * time…"), silently dropping the usage event. Staging in SQLite decouples
 * durability from the request's post-response grace window: a cut-short
 * drain leaves the rows in place for the next pass.
 *
 * Delivery is at-least-once — a drain that sends a batch but is killed
 * before the follow-up DELETE re-sends those rows next time. The usage
 * consumer dedupes on the event id (queues are at-least-once anyway).
 */
import type { UsageEventMsg } from './event'

/**
 * Rows drained per alarm. Comfortably under Cloudflare's `sendBatch`
 * limits (100 messages / 256 KB) given our messages are ~300 bytes of
 * pre-computed counts. A backlog above this drains across several
 * passes (see `flushUsageOutbox`'s reschedule-while-remaining).
 */
export const USAGE_DRAIN_BATCH = 100

export function ensureOutboxTable(sql: SqlStorage): void {
  sql.exec('CREATE TABLE IF NOT EXISTS usage_outbox (seq INTEGER PRIMARY KEY, msg TEXT NOT NULL)')
}

/** Append one usage event. `seq` auto-assigns (INTEGER PRIMARY KEY rowid). */
export function stageUsageRow(sql: SqlStorage, msg: UsageEventMsg): void {
  sql.exec('INSERT INTO usage_outbox (msg) VALUES (?)', JSON.stringify(msg))
}

/**
 * Drain up to `USAGE_DRAIN_BATCH` staged rows to the queue and delete
 * only what was accepted. Throws if the queue send fails — the caller
 * leaves the rows staged and reschedules. Returns how many were sent
 * and how many remain (so the caller can keep draining a backlog).
 */
export async function drainOutbox(
  sql: SqlStorage,
  queue: Queue
): Promise<{ sent: number; remaining: number }> {
  const rows = sql
    .exec('SELECT seq, msg FROM usage_outbox ORDER BY seq LIMIT ?', USAGE_DRAIN_BATCH)
    .toArray() as Array<{ seq: number; msg: string }>
  if (rows.length === 0) return { sent: 0, remaining: 0 }

  await queue.sendBatch(rows.map((r) => ({ body: JSON.parse(r.msg) as UsageEventMsg })))

  // Only the rows we just sent — a concurrent stage may have appended
  // a higher seq while sendBatch was in flight; leave those for the
  // next drain.
  const maxSeq = rows.reduce((m, r) => Math.max(m, r.seq), 0)
  sql.exec('DELETE FROM usage_outbox WHERE seq <= ?', maxSeq)

  const remaining = Number(
    (sql.exec('SELECT COUNT(*) AS n FROM usage_outbox').one() as { n: number }).n
  )
  return { sent: rows.length, remaining }
}
