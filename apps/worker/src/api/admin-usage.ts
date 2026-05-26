/**
 * Admin usage REST. `GET /api/admin/usage?days=N&userId=...&upstreamId=...`
 * returns rollups scoped to the (optional) user / upstream filters,
 * plus a top-users leaderboard for the org-wide view. All filters are
 * AND-combined.
 *
 * Read-only and admin-gated — see `auth/middleware.ts:requireAdmin`.
 */

import { Hono } from 'hono'
import type { AdminUsageResponse } from '@ctxlayer/shared'
import type { Env } from '../env'
import { requireAdmin, type AuthedVariables } from '../auth/middleware'
import {
  dailyTotals,
  topTools,
  topUpstreams,
  topUsers
} from '../db/queries/usage-read'
import { clampDays } from './usage'

export const adminUsageRoute = new Hono<{ Bindings: Env; Variables: AuthedVariables }>()
adminUsageRoute.use('*', requireAdmin)

adminUsageRoute.get('/', async (c) => {
  const url = new URL(c.req.url)
  const daysBack = clampDays(url.searchParams.get('days'))
  const userId = url.searchParams.get('userId')?.trim() || null
  const upstreamId = url.searchParams.get('upstreamId')?.trim() || null

  const scope = { daysBack, userId, upstreamId }
  const [daily, tools, upstreams, users] = await Promise.all([
    dailyTotals(c.env, scope),
    topTools(c.env, scope, 10),
    topUpstreams(c.env, scope, 10),
    topUsers(c.env, scope, 10)
  ])

  const body: AdminUsageResponse = {
    daysBack,
    dailyTotals: daily,
    topTools: tools,
    topUpstreams: upstreams,
    topUsers: users
  }
  return c.json(body)
})
