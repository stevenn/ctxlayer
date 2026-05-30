import { z } from 'zod'

/**
 * Response shapes for the M6 usage dashboards.
 *
 * `dailyTotals` is the time-series for the line/bar chart;
 * `topTools` / `topUpstreams` / `topUsers` are the leaderboard tables.
 * The admin response includes the user breakdown; the per-user
 * `/api/usage` omits it (the caller IS the user).
 */

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
  daysBack: z.number().int().min(1),
  dailyTotals: z.array(UsageDailyTotal),
  topTools: z.array(UsageTopTool),
  topUpstreams: z.array(UsageTopUpstream)
})
export type UsageResponse = z.infer<typeof UsageResponse>

export const AdminUsageResponse = UsageResponse.extend({
  topUsers: z.array(UsageTopUser)
})
export type AdminUsageResponse = z.infer<typeof AdminUsageResponse>
