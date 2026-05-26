/**
 * User-facing usage REST. `GET /api/usage?days=N` returns the
 * authed user's own rollup totals over the last N days plus a
 * top-tools / top-upstreams leaderboard. Defaults to 30 days
 * (matches the raw-event retention so the line chart and the
 * forensic drill-down agree on the window).
 *
 * Admin equivalent at `/api/admin/usage` adds top-users and
 * accepts `userId` / `upstreamId` filters.
 */

import { Hono } from 'hono'
import type { UsageResponse } from '@ctxlayer/shared'
import type { Env } from '../env'
import { requireUser, type AuthedVariables } from '../auth/middleware'
import { dailyTotals, topTools, topUpstreams } from '../db/queries/usage-read'

export const usageRoute = new Hono<{ Bindings: Env; Variables: AuthedVariables }>()
usageRoute.use('*', requireUser)

usageRoute.get('/', async (c) => {
  const url = new URL(c.req.url)
  const daysBack = clampDays(url.searchParams.get('days'))
  const user = c.get('user')

  const scope = { daysBack, userId: user.userId }
  const [daily, tools, upstreams] = await Promise.all([
    dailyTotals(c.env, scope),
    topTools(c.env, scope, 10),
    topUpstreams(c.env, scope, 10)
  ])

  const body: UsageResponse = {
    daysBack,
    dailyTotals: daily,
    topTools: tools,
    topUpstreams: upstreams
  }
  return c.json(body)
})

export function clampDays(raw: string | null): number {
  const n = raw ? Number(raw) : 30
  if (!Number.isFinite(n) || n < 1) return 30
  return Math.min(Math.floor(n), 365)
}
