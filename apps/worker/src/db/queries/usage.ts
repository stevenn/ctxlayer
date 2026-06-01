import type { Env } from '../../env'
import type { UsageEventMsg } from '../../usage/event'

/**
 * Write-side queries for the usage pipeline. Two writes per event:
 * one INSERT into `usage_events` (raw, 30-day retained) and one
 * UPSERT into `usage_rollups_daily` (per-day aggregate, retained
 * indefinitely).
 *
 * The rollup PK includes `upstream_id`; SQLite forbids `COALESCE`
 * in PK columns and the column is `NOT NULL DEFAULT ''`, so the
 * producer's nullable `upstreamId` becomes `''` here.
 */

const SECONDS_PER_DAY = 86400

export async function writeUsageEvent(env: Env, e: UsageEventMsg): Promise<void> {
  const day = Math.floor(e.ts / SECONDS_PER_DAY) * SECONDS_PER_DAY
  const upstreamForRaw = e.upstreamId ?? null
  const upstreamForRollup = e.upstreamId ?? ''
  const isError = e.status === 'error' || e.status === 'timeout' ? 1 : 0
  const isTimeout = e.status === 'timeout' ? 1 : 0
  const isTruncated = e.truncated ? 1 : 0

  // Single batched D1 transaction so we don't half-write on consumer
  // retry (the raw row and the rollup must move together).
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO usage_events
         (id, ts, user_id, session_id, upstream_id, tool,
          req_bytes, resp_bytes, req_tokens, resp_tokens,
          latency_ms, status, truncated)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`
    ).bind(
      e.id,
      e.ts,
      e.userId,
      e.sessionId,
      upstreamForRaw,
      e.tool,
      e.reqBytes,
      e.respBytes,
      e.reqTokens,
      e.respTokens,
      e.latencyMs,
      e.status,
      isTruncated
    ),
    env.DB.prepare(
      `INSERT INTO usage_rollups_daily
         (day, user_id, upstream_id, tool,
          calls, req_bytes, resp_bytes, req_tokens, resp_tokens,
          errors, timeouts, truncations)
       VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
       ON CONFLICT(day, user_id, upstream_id, tool) DO UPDATE SET
         calls       = calls       + 1,
         req_bytes   = req_bytes   + excluded.req_bytes,
         resp_bytes  = resp_bytes  + excluded.resp_bytes,
         req_tokens  = req_tokens  + excluded.req_tokens,
         resp_tokens = resp_tokens + excluded.resp_tokens,
         errors      = errors      + excluded.errors,
         timeouts    = timeouts    + excluded.timeouts,
         truncations = truncations + excluded.truncations`
    ).bind(
      day,
      e.userId,
      upstreamForRollup,
      e.tool,
      e.reqBytes,
      e.respBytes,
      e.reqTokens,
      e.respTokens,
      isError,
      isTimeout,
      isTruncated
    )
  ])
}

/**
 * Cron prune (nightly). Deletes raw usage_events older than the
 * retention window. Rollups are never pruned — they're tiny and
 * historic dashboards want them.
 */
export async function pruneUsageEvents(env: Env, daysToKeep: number): Promise<number> {
  const cutoff = Math.floor(Date.now() / 1000) - daysToKeep * SECONDS_PER_DAY
  const res = await env.DB.prepare(`DELETE FROM usage_events WHERE ts < ?1`).bind(cutoff).run()
  return res.meta?.changes ?? 0
}
