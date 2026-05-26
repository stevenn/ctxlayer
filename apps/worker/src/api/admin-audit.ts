/**
 * Admin REST for the Audit-log viewer (M5 phase 3).
 *
 * `GET /api/admin/audit?before=<ts>&action=<prefix>&actorId=<id>&limit=<n>`
 * returns a page of audit entries newest-first plus `nextBefore`
 * cursor. `limit` is clamped to [1, 200]; default 50.
 *
 * No mutations; this endpoint is read-only. Writes land via
 * `audit/log.ts` from every other admin/user-facing route.
 */

import { Hono } from 'hono'
import type { Env } from '../env'
import { requireAdmin, type AuthedVariables } from '../auth/middleware'
import { listAuditEntries } from '../db/queries/audit'

export const adminAuditRoute = new Hono<{ Bindings: Env; Variables: AuthedVariables }>()
adminAuditRoute.use('*', requireAdmin)

adminAuditRoute.get('/', async (c) => {
  const url = new URL(c.req.url)
  const beforeRaw = url.searchParams.get('before')
  const limitRaw = url.searchParams.get('limit')
  const action = url.searchParams.get('action')?.trim() || undefined
  const actorId = url.searchParams.get('actorId')?.trim() || undefined

  const before = beforeRaw ? Number(beforeRaw) : undefined
  if (beforeRaw && (!Number.isFinite(before) || before! < 0)) {
    return c.json({ error: 'bad_request', hint: '`before` must be a unix timestamp.' }, 400)
  }

  let limit = limitRaw ? Number(limitRaw) : 50
  if (!Number.isFinite(limit) || limit < 1) limit = 50
  if (limit > 200) limit = 200

  const page = await listAuditEntries(c.env, {
    limit,
    before,
    actionPrefix: action,
    actorId
  })
  return c.json(page)
})
