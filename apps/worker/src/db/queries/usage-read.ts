import type { Env } from '../../env'
import { USAGE_RANGE_DAYS, type UsageRange } from '@ctxlayer/shared'

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

/**
 * Midnight-UTC epoch cutoff for a named range, or null for `all` (no lower
 * bound). Ranges are inclusive of today, so `7d` keeps today + the 6 prior days.
 */
export function rangeCutoff(range: UsageRange): number | null {
  const days = USAGE_RANGE_DAYS[range]
  if (days == null) return null
  const todayMidnight = Math.floor(Date.now() / 1000 / SECONDS_PER_DAY) * SECONDS_PER_DAY
  return todayMidnight - (days - 1) * SECONDS_PER_DAY
}

// Build the WHERE clause for a scope. `dayCol` is the (possibly
// table-qualified) day column for this query; the day filter is omitted
// entirely when `sinceDay` is null (the `all` range).
function whereFor(scope: UsageScope, dayCol: string): { where: string; binds: unknown[] } {
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
