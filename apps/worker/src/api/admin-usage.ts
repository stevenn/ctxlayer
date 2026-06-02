/**
 * Admin usage REST. `GET /api/admin/usage?range=30d&userId=...&upstreamId=...`
 * returns rollups scoped to the (optional) user / upstream filters, plus a
 * top-users leaderboard for the org-wide view. All filters are AND-combined
 * and the leaderboards follow the selected time window.
 *
 * Read-only and admin-gated — see `auth/middleware.ts:requireAdmin`.
 */

import { Hono } from 'hono'
import type { AdminUsageResponse } from '@ctxlayer/shared'
import type { Env } from '../env'
import { requireAdmin, type AuthedVariables } from '../auth/middleware'
import { dailyTotals, topTools, topUpstreams, topUsers, rangeCutoff } from '../db/queries/usage-read'
import { parseRange } from './usage'

export const adminUsageRoute = new Hono<{ Bindings: Env; Variables: AuthedVariables }>()
adminUsageRoute.use('*', requireAdmin)

adminUsageRoute.get('/', async (c) => {
  const url = new URL(c.req.url)
  const range = parseRange(url.searchParams.get('range'))
  const userId = url.searchParams.get('userId')?.trim() || null
  const upstreamId = url.searchParams.get('upstreamId')?.trim() || null

  const scope = { sinceDay: rangeCutoff(range), userId, upstreamId }
  const [daily, tools, upstreams, users] = await Promise.all([
    dailyTotals(c.env, scope),
    topTools(c.env, scope, 10),
    topUpstreams(c.env, scope, 10),
    topUsers(c.env, scope, 10)
  ])

  const body: AdminUsageResponse = {
    range,
    dailyTotals: daily,
    topTools: tools,
    topUpstreams: upstreams,
    topUsers: users
  }
  return c.json(body)
})
