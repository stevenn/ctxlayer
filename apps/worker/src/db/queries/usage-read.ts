import type { Env } from '../../env'
import { USAGE_RANGE_DAYS, localDayIndex, type UsageRange } from '@ctxlayer/shared'

/**
 * Read helpers for the usage dashboards. All reads hit
 * `usage_rollups_daily` (cheap; one row per day×user×upstream×tool).
 * `usage_events` is reserved for forensic drill-downs within the
 * 30-day raw-retention window.
 *
 * `userId` filter: required for `/api/usage` (callers see their own
 * rows only). Optional for `/api/admin/usage` (admins can scope to
 * any user or aggregate across the org).
 */

const SECONDS_PER_DAY = 86400

export interface UsageScope {
  // Midnight-UTC epoch lower bound (inclusive); null = all time.
  sinceDay: number | null
  userId?: string | null
  upstreamId?: string | null
}

export interface DailyTotalRow {
  day: number
  calls: number
  reqTokens: number
  respTokens: number
  reqBytes: number
  respBytes: number
  errors: number
}

export interface TopToolRow {
  tool: string
  upstreamId: string // '' for built-in
  calls: number
  reqTokens: number
  respTokens: number
  errors: number
  timeouts: number
  truncations: number
}

export interface TopUpstreamRow {
  upstreamId: string // '' for built-in
  upstreamSlug: string | null
  upstreamName: string | null
  calls: number
  reqTokens: number
  respTokens: number
  errors: number
  timeouts: number
  truncations: number
}

export interface TopUserRow {
  userId: string
  email: string | null
  calls: number
  reqTokens: number
  respTokens: number
  errors: number
}

export interface RecentErrorRow {
  ts: number
  tool: string
  upstreamId: string // '' = built-in / local
  upstreamSlug: string | null
  code: string
  message: string | null
}

export interface ActiveUserRow {
  userId: string
  email: string | null
  name: string | null
  calls: number
  lastSeen: number // epoch seconds of the user's most recent call in the window
}

// Raw `usage_events` retains 30 days (the nightly prune). The drill-down
// can't reach further back than that even when the range dropdown asks
// for more, so we clamp the lower bound to the retention floor.
const RAW_RETENTION_DAYS = 30
const RECENT_ERRORS_LIMIT = 200

/**
 * Lower-bound cutoff (UTC epoch, not necessarily day-aligned) for a named
 * range, evaluated in the viewer's timezone (`offsetSec` = seconds east of
 * UTC), or null for `all`. Ranges are inclusive of the viewer's current local
 * day. A UTC-day rollup is attributed to the local date its UTC-noon falls on,
 * so the window follows the viewer's calendar; sub-day precision isn't
 * recoverable from day rollups (see `rollupLocalDayIndex`).
 */
export function rangeCutoff(range: UsageRange, offsetSec: number): number | null {
  const days = USAGE_RANGE_DAYS[range]
  if (days == null) return null
  const todayIndex = localDayIndex(Math.floor(Date.now() / 1000), offsetSec)
  const cutoffIndex = todayIndex - (days - 1)
  // Include a rollup (UTC midnight `day`) iff its UTC-noon maps to a local date
  // >= cutoffIndex:  day + DAY/2 + offsetSec >= cutoffIndex*DAY.
  return cutoffIndex * SECONDS_PER_DAY - SECONDS_PER_DAY / 2 - offsetSec
}

// Build the WHERE clause for a scope. `dayCol` is the (possibly
// table-qualified) day column for this query; the day filter is omitted
// entirely when `sinceDay` is null (the `all` range).
// `dayCol` is interpolated into identifier position (SQL identifiers can't be
// bound parameters). It is therefore constrained to the exact set the callers
// pass — all hardcoded literals today. The guard turns any future
// user-controlled value into a hard error instead of a SQL-injection vector,
// and keeps the parameterized `?` binds the only path user data ever takes.
const DAY_COLUMNS = new Set(['day', 'r.day', 'u.day'])

function whereFor(scope: UsageScope, dayCol: string): { where: string; binds: unknown[] } {
  if (!DAY_COLUMNS.has(dayCol)) throw new Error('whereFor: unrecognized day column')
  const where: string[] = []
  const binds: unknown[] = []
  if (scope.sinceDay != null) {
    where.push(`${dayCol} >= ?`)
    binds.push(scope.sinceDay)
  }
  if (scope.userId) {
    where.push(`user_id = ?`)
    binds.push(scope.userId)
  }
  if (scope.upstreamId != null) {
    where.push(`upstream_id = ?`)
    binds.push(scope.upstreamId)
  }
  return { where: where.length ? `WHERE ${where.join(' AND ')}` : '', binds }
}

export async function dailyTotals(env: Env, scope: UsageScope): Promise<DailyTotalRow[]> {
  const { where, binds } = whereFor(scope, 'day')
  const sql = `
    SELECT day,
           SUM(calls)       AS calls,
           SUM(req_tokens)  AS req_tokens,
           SUM(resp_tokens) AS resp_tokens,
           SUM(req_bytes)   AS req_bytes,
           SUM(resp_bytes)  AS resp_bytes,
           SUM(errors)      AS errors
    FROM usage_rollups_daily
    ${where}
    GROUP BY day
    ORDER BY day ASC
  `
  const { results } = await env.DB.prepare(sql)
    .bind(...binds)
    .all<{
      day: number
      calls: number
      req_tokens: number
      resp_tokens: number
      req_bytes: number
      resp_bytes: number
      errors: number
    }>()
  return (results ?? []).map((r) => ({
    day: r.day,
    calls: r.calls ?? 0,
    reqTokens: r.req_tokens ?? 0,
    respTokens: r.resp_tokens ?? 0,
    reqBytes: r.req_bytes ?? 0,
    respBytes: r.resp_bytes ?? 0,
    errors: r.errors ?? 0
  }))
}

export async function topTools(env: Env, scope: UsageScope, limit = 10): Promise<TopToolRow[]> {
  const { where, binds } = whereFor(scope, 'day')
  const sql = `
    SELECT tool, upstream_id,
           SUM(calls)       AS calls,
           SUM(req_tokens)  AS req_tokens,
           SUM(resp_tokens) AS resp_tokens,
           SUM(errors)      AS errors,
           SUM(timeouts)    AS timeouts,
           SUM(truncations) AS truncations
    FROM usage_rollups_daily
    ${where}
    GROUP BY tool, upstream_id
    ORDER BY calls DESC
    LIMIT ?
  `
  const { results } = await env.DB.prepare(sql)
    .bind(...binds, limit)
    .all<{
      tool: string
      upstream_id: string
      calls: number
      req_tokens: number
      resp_tokens: number
      errors: number
      timeouts: number
      truncations: number
    }>()
  return (results ?? []).map((r) => ({
    tool: r.tool,
    upstreamId: r.upstream_id ?? '',
    calls: r.calls ?? 0,
    reqTokens: r.req_tokens ?? 0,
    respTokens: r.resp_tokens ?? 0,
    errors: r.errors ?? 0,
    timeouts: r.timeouts ?? 0,
    truncations: r.truncations ?? 0
  }))
}

export async function topUpstreams(
  env: Env,
  scope: UsageScope,
  limit = 10
): Promise<TopUpstreamRow[]> {
  const { where, binds } = whereFor(scope, 'u.day')
  const sql = `
    SELECT u.upstream_id,
           us.slug         AS upstream_slug,
           us.display_name AS upstream_name,
           SUM(u.calls)       AS calls,
           SUM(u.req_tokens)  AS req_tokens,
           SUM(u.resp_tokens) AS resp_tokens,
           SUM(u.errors)      AS errors,
           SUM(u.timeouts)    AS timeouts,
           SUM(u.truncations) AS truncations
    FROM usage_rollups_daily u
    LEFT JOIN upstream_servers us ON us.id = u.upstream_id
    ${where}
    GROUP BY u.upstream_id, us.slug, us.display_name
    ORDER BY calls DESC
    LIMIT ?
  `
  const { results } = await env.DB.prepare(sql)
    .bind(...binds, limit)
    .all<{
      upstream_id: string
      upstream_slug: string | null
      upstream_name: string | null
      calls: number
      req_tokens: number
      resp_tokens: number
      errors: number
      timeouts: number
      truncations: number
    }>()
  return (results ?? []).map((r) => ({
    upstreamId: r.upstream_id ?? '',
    upstreamSlug: r.upstream_slug ?? null,
    upstreamName: r.upstream_name ?? null,
    calls: r.calls ?? 0,
    reqTokens: r.req_tokens ?? 0,
    respTokens: r.resp_tokens ?? 0,
    errors: r.errors ?? 0,
    timeouts: r.timeouts ?? 0,
    truncations: r.truncations ?? 0
  }))
}

export async function topUsers(env: Env, scope: UsageScope, limit = 10): Promise<TopUserRow[]> {
  // No userId filter — even when an admin passes one, it short-circuits
  // to a single-row "top user" which is exactly what the dashboard
  // wants for a drill-down summary.
  const { where, binds } = whereFor(scope, 'r.day')
  const sql = `
    SELECT r.user_id,
           u.email AS email,
           SUM(r.calls)       AS calls,
           SUM(r.req_tokens)  AS req_tokens,
           SUM(r.resp_tokens) AS resp_tokens,
           SUM(r.errors)      AS errors
    FROM usage_rollups_daily r
    LEFT JOIN users u ON u.id = r.user_id
    ${where}
    GROUP BY r.user_id, u.email
    ORDER BY calls DESC
    LIMIT ?
  `
  const { results } = await env.DB.prepare(sql)
    .bind(...binds, limit)
    .all<{
      user_id: string
      email: string | null
      calls: number
      req_tokens: number
      resp_tokens: number
      errors: number
    }>()
  return (results ?? []).map((r) => ({
    userId: r.user_id,
    email: r.email ?? null,
    calls: r.calls ?? 0,
    reqTokens: r.req_tokens ?? 0,
    respTokens: r.resp_tokens ?? 0,
    errors: r.errors ?? 0
  }))
}

/**
 * Recent individual failures (status <> 'ok') for the usage error table.
 * Unlike the leaderboards this reads the RAW `usage_events` rows so each
 * carries its classified code + scrubbed message; the lower bound is
 * clamped to the 30-day raw-retention floor regardless of the requested
 * range. Honours the same user / upstream scope filters as the rollup
 * reads. Most-recent first, capped. A code is synthesised for rows that
 * predate the error-detail columns so the wire shape stays non-null.
 */
export async function recentErrors(
  env: Env,
  scope: UsageScope,
  limit = RECENT_ERRORS_LIMIT
): Promise<RecentErrorRow[]> {
  const retentionFloor = Math.floor(Date.now() / 1000) - RAW_RETENTION_DAYS * SECONDS_PER_DAY
  const since = scope.sinceDay == null ? retentionFloor : Math.max(scope.sinceDay, retentionFloor)
  const where: string[] = [`e.status <> 'ok'`, `e.ts >= ?`]
  const binds: unknown[] = [since]
  if (scope.userId) {
    where.push(`e.user_id = ?`)
    binds.push(scope.userId)
  }
  if (scope.upstreamId != null) {
    where.push(`e.upstream_id = ?`)
    binds.push(scope.upstreamId)
  }
  const sql = `
    SELECT e.ts, e.tool, e.upstream_id, us.slug AS upstream_slug,
           e.error_code, e.error_message
    FROM usage_events e
    LEFT JOIN upstream_servers us ON us.id = e.upstream_id
    WHERE ${where.join(' AND ')}
    ORDER BY e.ts DESC
    LIMIT ?
  `
  const { results } = await env.DB.prepare(sql)
    .bind(...binds, limit)
    .all<{
      ts: number
      tool: string
      upstream_id: string | null
      upstream_slug: string | null
      error_code: string | null
      error_message: string | null
    }>()
  return (results ?? []).map((r) => {
    const upstreamId = r.upstream_id ?? ''
    return {
      ts: r.ts,
      tool: r.tool,
      upstreamId,
      upstreamSlug: r.upstream_slug ?? null,
      // Fallback for pre-0029 error rows: no stored class, so infer
      // local vs remote from whether an upstream was involved.
      code: r.error_code ?? (upstreamId ? 'upstream_error' : 'local_error'),
      message: r.error_message ?? null
    }
  })
}

const SECONDS_PER_HOUR = 3600
const ACTIVE_USERS_DEFAULT_SECONDS = 24 * SECONDS_PER_HOUR
const ACTIVE_USERS_MIN_SECONDS = SECONDS_PER_HOUR
// Raw `usage_events` retains 30 days; a longer window can't see further back.
const ACTIVE_USERS_MAX_SECONDS = RAW_RETENTION_DAYS * SECONDS_PER_DAY

/**
 * Parse an `active_users` look-back window (`<n>h` / `<n>d`) into seconds,
 * clamped to [1h, 30d]. `undefined` or an unparseable value (the zod regex
 * should have already rejected the latter) falls back to 24h.
 */
export function parseActiveUsersWindow(window: string | undefined): number {
  const m = window ? /^(\d+)([hd])$/.exec(window) : null
  if (!m) return ACTIVE_USERS_DEFAULT_SECONDS
  const secs = Number(m[1]) * (m[2] === 'd' ? SECONDS_PER_DAY : SECONDS_PER_HOUR)
  return Math.min(Math.max(secs, ACTIVE_USERS_MIN_SECONDS), ACTIVE_USERS_MAX_SECONDS)
}

/**
 * Distinct users active in the last `windowSeconds`, read from the raw
 * `usage_events` log (indexed on `ts`). One row per user with their call
 * count + most-recent-call time, most active first; `email`/`name` come from
 * a LEFT JOIN so a hard-deleted user still counts (as nulls). The distinct
 * active-user COUNT is the row count. Admin-only at the call site.
 */
export async function activeUsers(
  env: Env,
  windowSeconds: number
): Promise<{ since: number; count: number; users: ActiveUserRow[] }> {
  const since = Math.floor(Date.now() / 1000) - windowSeconds
  const sql = `
    SELECT e.user_id,
           u.email   AS email,
           u.name    AS name,
           COUNT(*)  AS calls,
           MAX(e.ts) AS last_seen
    FROM usage_events e
    LEFT JOIN users u ON u.id = e.user_id
    WHERE e.ts >= ?1
    GROUP BY e.user_id, u.email, u.name
    ORDER BY calls DESC, last_seen DESC
  `
  const { results } = await env.DB.prepare(sql)
    .bind(since)
    .all<{
      user_id: string
      email: string | null
      name: string | null
      calls: number
      last_seen: number
    }>()
  const users: ActiveUserRow[] = (results ?? []).map((r) => ({
    userId: r.user_id,
    email: r.email ?? null,
    name: r.name ?? null,
    calls: r.calls ?? 0,
    lastSeen: r.last_seen ?? 0
  }))
  return { since, count: users.length, users }
}

/**
 * Per-upstream rollup totals for the skill drafter's context bundle
 * (skills/draft-context-bundle.ts). `mangledTool` narrows to one tool when
 * non-null; otherwise sums across the whole upstream. `sinceDay` is an
 * epoch-day lower bound. Returns total calls + per-day counts (raw day
 * epochs; the caller formats them).
 */
export async function getUpstreamUsageRollup(
  env: Env,
  args: { userId: string; upstreamId: string; sinceDay: number; mangledTool: string | null }
): Promise<{ totalCalls: number; byDay: Array<{ day: number; calls: number }> }> {
  const totalRow = await env.DB.prepare(
    `SELECT COALESCE(SUM(calls), 0) AS calls
     FROM usage_rollups_daily
     WHERE user_id = ?1 AND upstream_id = ?2 AND day >= ?3
       AND (?4 IS NULL OR tool = ?4)`
  )
    .bind(args.userId, args.upstreamId, args.sinceDay, args.mangledTool)
    .first<{ calls: number }>()
  const totalCalls = totalRow?.calls ?? 0
  if (totalCalls === 0) return { totalCalls: 0, byDay: [] }

  const dayRows = await env.DB.prepare(
    `SELECT day, SUM(calls) AS calls
     FROM usage_rollups_daily
     WHERE user_id = ?1 AND upstream_id = ?2 AND day >= ?3
       AND (?4 IS NULL OR tool = ?4)
     GROUP BY day
     ORDER BY day ASC`
  )
    .bind(args.userId, args.upstreamId, args.sinceDay, args.mangledTool)
    .all<{ day: number; calls: number }>()
  return { totalCalls, byDay: dayRows.results ?? [] }
}
