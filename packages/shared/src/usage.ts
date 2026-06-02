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

export const UsageTopTool = z.object({
  tool: z.string(),
  upstreamId: z.string(), // '' = built-in
  calls: z.number().int().min(0),
  reqTokens: z.number().int().min(0),
  respTokens: z.number().int().min(0),
  errors: z.number().int().min(0),
  // WI-5 resilience analytics. Default 0 so older rows/clients parse.
  timeouts: z.number().int().min(0).default(0),
  truncations: z.number().int().min(0).default(0)
})
export type UsageTopTool = z.infer<typeof UsageTopTool>

export const UsageTopUpstream = z.object({
  upstreamId: z.string(),
  upstreamSlug: z.string().nullable(),
  upstreamName: z.string().nullable(),
  calls: z.number().int().min(0),
  reqTokens: z.number().int().min(0),
  respTokens: z.number().int().min(0),
  errors: z.number().int().min(0),
  // WI-5 resilience analytics. Default 0 so older rows/clients parse.
  timeouts: z.number().int().min(0).default(0),
  truncations: z.number().int().min(0).default(0)
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

export const UsageResponse = z.object({
  range: UsageRange,
  dailyTotals: z.array(UsageDailyTotal),
  topTools: z.array(UsageTopTool),
  topUpstreams: z.array(UsageTopUpstream)
})
export type UsageResponse = z.infer<typeof UsageResponse>

export const AdminUsageResponse = UsageResponse.extend({
  topUsers: z.array(UsageTopUser)
})
export type AdminUsageResponse = z.infer<typeof AdminUsageResponse>
