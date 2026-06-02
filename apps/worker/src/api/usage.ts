/**
 * User-facing usage REST. `GET /api/usage?range=30d` returns the authed
 * user's own rollup totals over the selected window, plus a top-tools /
 * top-upstreams leaderboard (all scoped to the same window). Defaults to
 * the last 30 days; `range` is one of the `UsageRange` enum values.
 *
 * Admin equivalent at `/api/admin/usage` adds top-users and accepts
 * `userId` / `upstreamId` filters.
 */

import { Hono } from 'hono'
import { UsageRange, type UsageResponse } from '@ctxlayer/shared'
import type { Env } from '../env'
import { requireUser, type AuthedVariables } from '../auth/middleware'
import { dailyTotals, topTools, topUpstreams, rangeCutoff } from '../db/queries/usage-read'

export const usageRoute = new Hono<{ Bindings: Env; Variables: AuthedVariables }>()
usageRoute.use('*', requireUser)

usageRoute.get('/', async (c) => {
  const url = new URL(c.req.url)
  const range = parseRange(url.searchParams.get('range'))
  const offsetSec = parseOffset(url.searchParams.get('tz'))
  const user = c.get('user')

  const scope = { sinceDay: rangeCutoff(range, offsetSec), userId: user.userId }
  const [daily, tools, upstreams] = await Promise.all([
    dailyTotals(c.env, scope),
    topTools(c.env, scope, 10),
    topUpstreams(c.env, scope, 10)
  ])

  const body: UsageResponse = {
    range,
    dailyTotals: daily,
    topTools: tools,
    topUpstreams: upstreams
  }
  return c.json(body)
})

// Parse the `range` query param; defaults to last 30 days on anything invalid.
export function parseRange(raw: string | null): UsageRange {
  const parsed = UsageRange.safeParse(raw)
  return parsed.success ? parsed.data : '30d'
}

// Viewer UTC offset (seconds) from the `tz` query param (minutes east of UTC,
// i.e. `-new Date().getTimezoneOffset()`). Clamped to ±14h; defaults to UTC.
export function parseOffset(raw: string | null): number {
  const min = raw ? Number(raw) : 0
  if (!Number.isFinite(min)) return 0
  return Math.max(-14 * 60, Math.min(14 * 60, Math.trunc(min))) * 60
}
