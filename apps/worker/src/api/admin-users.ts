/**
 * Admin REST for the Users page (M5 phase 1).
 *
 * - `GET    /api/admin/users` — list every user with role + IdP + team
 *   membership inline + credential count.
 * - `PATCH  /api/admin/users/:id` — change role. Refuses self-demote
 *   of the last admin (or the org loses admin access entirely).
 * - `DELETE /api/admin/users/:id/credentials` — revoke every stored
 *   upstream credential for that user. Used when offboarding or
 *   responding to a token-leak suspicion.
 *
 * Every mutation writes an `audit_log` row via `audit/log.ts`. The
 * audit viewer (later M5 phase) reads them.
 */

import { Hono } from 'hono'
import { UpdateUserRoleRequest } from '@ctxlayer/shared'
import type { Env } from '../env'
import { requireAdmin, type AuthedVariables } from '../auth/middleware'
import { requireCsrf } from '../auth/csrf'
import {
  countAdmins,
  findById,
  listAdminUserRows,
  revokeAllUserCredentials,
  updateUserRole
} from '../db/queries/users'
import { audit } from '../audit/log'

export const adminUsersRoute = new Hono<{ Bindings: Env; Variables: AuthedVariables }>()
adminUsersRoute.use('*', requireAdmin)

adminUsersRoute.get('/', async (c) => {
  return c.json(await listAdminUserRows(c.env))
})

adminUsersRoute.patch('/:id', requireCsrf, async (c) => {
  const targetId = c.req.param('id')
  const actor = c.get('user')

  const parsed = UpdateUserRoleRequest.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    return c.json({ error: 'bad_request', issues: parsed.error.issues }, 400)
  }
  const nextRole = parsed.data.role

  const target = await findById(c.env, targetId)
  if (!target) return c.json({ error: 'not_found' }, 404)
  if (target.role === nextRole) {
    // No-op; treat as success so the SPA can be idempotent.
    return new Response(null, { status: 204 })
  }

  // Guard: refuse to demote the last admin. Without this any single-
  // admin org could click itself out of admin access and never come
  // back without a database edit.
  if (target.role === 'admin' && nextRole !== 'admin') {
    const admins = await countAdmins(c.env)
    if (admins <= 1) {
      return c.json(
        {
          error: 'last_admin',
          hint: 'Promote at least one other user to admin before demoting this one.'
        },
        400
      )
    }
  }

  await updateUserRole(c.env, targetId, nextRole)
  await audit(c.env, {
    actorId: actor.userId,
    action: nextRole === 'admin' ? 'user.promote' : 'user.demote',
    target: targetId,
    meta: { from: target.role, to: nextRole, targetEmail: target.email }
  })
  return new Response(null, { status: 204 })
})

adminUsersRoute.delete('/:id/credentials', requireCsrf, async (c) => {
  const targetId = c.req.param('id')
  const actor = c.get('user')
  const target = await findById(c.env, targetId)
  if (!target) return c.json({ error: 'not_found' }, 404)

  const removed = await revokeAllUserCredentials(c.env, targetId)
  await audit(c.env, {
    actorId: actor.userId,
    action: 'credential.revoke_all',
    target: targetId,
    meta: { removed, targetEmail: target.email }
  })
  return c.json({ removed })
})
