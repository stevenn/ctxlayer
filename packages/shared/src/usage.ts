import { z } from 'zod'

/**
 * Response shapes for the usage dashboards.
 *
 * `dailyTotals` is the time-series for the bar chart;
 * `topTools` / `topUpstreams` / `topUsers` are the leaderboard tables —
 * all scoped to the same `range` window, so they follow the time filter.
 * The admin response includes the user breakdown; the per-user
 * `/api/usage` omits it (the caller IS the user).
 */

// Selectable time windows for the dashboards. All but `all` are
// inclusive-of-today spans (e.g. `7d` = today + the 6 prior days).
export const UsageRange = z.enum(['1d', '2d', '7d', '30d', '90d', 'all'])
export type UsageRange = z.infer<typeof UsageRange>

// Days each range spans, for cutoff math + chart fill. `all` → null
// (no lower bound — the server omits the day filter entirely).
export const USAGE_RANGE_DAYS: Record<UsageRange, number | null> = {
  '1d': 1,
  '2d': 2,
  '7d': 7,
  '30d': 30,
  '90d': 90,
  all: null
}

export const USAGE_RANGE_LABEL: Record<UsageRange, string> = {
  '1d': 'Today',
  '2d': 'Last 2 days',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
  all: 'All time'
}

// ---- Timezone-aware day bucketing ----------------------------------------
// Rollups are stored as UTC-day buckets, so a viewer's local-day windows are
// approximated by relabelling each UTC-day to the local date it mostly covers.
// These helpers are shared by the server cutoff and the client chart so both
// agree on what "a day" is for a given viewer offset (seconds east of UTC).
const DAY_SECONDS = 86400

/** Local-calendar day index for a UTC epoch (seconds). */
export function localDayIndex(utcSec: number, offsetSec: number): number {
  return Math.floor((utcSec + offsetSec) / DAY_SECONDS)
}

/**
 * The local date a UTC-day rollup (its UTC-midnight `day`) is attributed to:
 * the date its UTC-noon falls on — i.e. the local day it mostly overlaps.
 */
export function rollupLocalDayIndex(day: number, offsetSec: number): number {
  return localDayIndex(day + DAY_SECONDS / 2, offsetSec)
}

export const UsageDailyTotal = z.object({
  day: z.number().int(), // unix seconds, midnight UTC
  calls: z.number().int().min(0),
  reqTokens: z.number().int().min(0),
  respTokens: z.number().int().min(0),
  reqBytes: z.number().int().min(0),
  respBytes: z.number().int().min(0),
  errors: z.number().int().min(0)
})
export type UsageDailyTotal = z.infer<typeof UsageDailyTotal>

/** Per-row counters shared by the top-tools / top-upstreams breakdowns. */
export const UsageCounters = z.object({
  calls: z.number().int().min(0),
  reqTokens: z.number().int().min(0),
  respTokens: z.number().int().min(0),
  errors: z.number().int().min(0),
  // WI-5 resilience analytics. Default 0 so older rows/clients parse.
  timeouts: z.number().int().min(0).default(0),
  truncations: z.number().int().min(0).default(0)
})
export type UsageCounters = z.infer<typeof UsageCounters>

export const UsageTopTool = UsageCounters.extend({
  tool: z.string(),
  upstreamId: z.string() // '' = built-in
})
export type UsageTopTool = z.infer<typeof UsageTopTool>

export const UsageTopUpstream = UsageCounters.extend({
  upstreamId: z.string(),
  upstreamSlug: z.string().nullable(),
  upstreamName: z.string().nullable()
})
export type UsageTopUpstream = z.infer<typeof UsageTopUpstream>

export const UsageTopUser = z.object({
  userId: z.string(),
  email: z.string().nullable(),
  calls: z.number().int().min(0),
  reqTokens: z.number().int().min(0),
  respTokens: z.number().int().min(0),
  errors: z.number().int().min(0)
})
export type UsageTopUser = z.infer<typeof UsageTopUser>

// Coarse, filterable class for a failed tool call. `local_error` is a
// built-in / ctxlayer-side failure; every other code involved a remote
// upstream. Exported for the SPA's label/colour maps + filter options.
export const USAGE_ERROR_CODES = [
  'timeout',
  'upstream_5xx',
  'upstream_4xx',
  'upstream_auth',
  'upstream_unreachable',
  'upstream_error',
  'local_error'
] as const
export type UsageErrorCode = (typeof USAGE_ERROR_CODES)[number]

// One failed tool call for the error drill-down table. Sourced from the
// raw `usage_events` table (not the rollups), so the listing is bounded
// by the 30-day raw retention window. `upstreamId === ''` ⇒ a built-in /
// local call (the UI derives the local/remote origin from it). `code` is
// typed loosely so a worker that learns a new class can't fail an older
// SPA's response parse — the UI maps known codes and shows the rest
// verbatim. `message` is credential-scrubbed server-side (host/IP/URL
// kept); null when an error predates this column.
export const UsageErrorRow = z.object({
  ts: z.number().int(), // unix seconds
  tool: z.string(),
  upstreamId: z.string(), // '' = built-in / local
  upstreamSlug: z.string().nullable(),
  code: z.string(),
  message: z.string().nullable()
})
export type UsageErrorRow = z.infer<typeof UsageErrorRow>

export const UsageResponse = z.object({
  range: UsageRange,
  dailyTotals: z.array(UsageDailyTotal),
  topTools: z.array(UsageTopTool),
  topUpstreams: z.array(UsageTopUpstream),
  // Recent individual failures within the window (most-recent first,
  // capped). Default [] so a response from a worker predating this field
  // still parses on a newer SPA.
  recentErrors: z.array(UsageErrorRow).default([])
})
export type UsageResponse = z.infer<typeof UsageResponse>

// Async submit→poll analytics (WI-6). Sourced from the `async_jobs` table,
// whose rows are retained 30 days (matching usage_events; only the heavy
// result_json blob is cleared after 1 day). `durationMs` is the background run
// time of a completed job (completed_at − created_at); null while still
// running. `timedOut` is the subset of `error` whose class is 'timeout'.
// Durations are null when no job has completed yet.
export const UsageAsyncSummary = z.object({
  total: z.number().int().min(0),
  done: z.number().int().min(0),
  running: z.number().int().min(0),
  error: z.number().int().min(0),
  timedOut: z.number().int().min(0),
  avgDurationMs: z.number().int().min(0).nullable(),
  maxDurationMs: z.number().int().min(0).nullable()
})
export type UsageAsyncSummary = z.infer<typeof UsageAsyncSummary>

export const UsageAsyncJobRow = z.object({
  id: z.string(),
  tool: z.string(), // native upstream tool name
  upstreamId: z.string(),
  upstreamSlug: z.string().nullable(),
  status: z.string(), // running | done | error (loose so a new value can't fail parse)
  createdAt: z.number().int(), // unix seconds
  completedAt: z.number().int().nullable(),
  durationMs: z.number().int().min(0).nullable(),
  errorCode: z.string().nullable()
})
export type UsageAsyncJobRow = z.infer<typeof UsageAsyncJobRow>

const EMPTY_ASYNC_SUMMARY: UsageAsyncSummary = {
  total: 0,
  done: 0,
  running: 0,
  error: 0,
  timedOut: 0,
  avgDurationMs: null,
  maxDurationMs: null
}

export const AdminUsageResponse = UsageResponse.extend({
  topUsers: z.array(UsageTopUser),
  // Defaulted so a response from a worker predating WI-6 still parses.
  asyncSummary: UsageAsyncSummary.default(EMPTY_ASYNC_SUMMARY),
  asyncJobs: z.array(UsageAsyncJobRow).default([])
})
export type AdminUsageResponse = z.infer<typeof AdminUsageResponse>
