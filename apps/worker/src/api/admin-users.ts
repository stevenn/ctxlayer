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

import { Hono, type Context } from 'hono'
import { SetUserRolesRequest, UpdateUserRoleRequest } from '@ctxlayer/shared'
import type { Env } from '../env'
import { requireAdmin, type AuthedVariables } from '../auth/middleware'
import { requireCsrf } from '../auth/csrf'
import {
  countActiveAdmins,
  deleteUser,
  findById,
  listAdminUserRows,
  revokeAllUserCredentials,
  setUserStatus,
  updateUserRole,
  type UserRow
} from '../db/queries/users'
import { setUserRoles } from '../db/queries/roles'
import { revokeAllUserGrants } from '../oauth/revoke-grants'
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

  // Guard: refuse to demote the last *active* admin. Without this any
  // single-admin org could click itself out of admin access and never
  // come back without a database edit. A suspended co-admin is not a
  // safety net, so we count active admins other than the target.
  if (target.role === 'admin' && nextRole !== 'admin') {
    if ((await countActiveAdmins(c.env, target.id)) < 1) {
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

// Replace a user's entire org-role set. CSRF gated per-mutation (this
// router doesn't apply requireCsrf router-wide). A bad role id fails the
// FK insert inside the batch → 400.
adminUsersRoute.put('/:id/roles', requireCsrf, async (c) => {
  const targetId = c.req.param('id')
  const actor = c.get('user')
  const target = await findById(c.env, targetId)
  if (!target) return c.json({ error: 'not_found' }, 404)
  const parsed = SetUserRolesRequest.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    return c.json({ error: 'bad_request', issues: parsed.error.issues }, 400)
  }
  try {
    await setUserRoles(c.env, targetId, parsed.data.roleIds)
  } catch (err) {
    if (isForeignKeyViolation(err)) return c.json({ error: 'unknown_role' }, 400)
    throw err
  }
  await audit(c.env, {
    actorId: actor.userId,
    action: 'user.roles_set',
    target: targetId,
    meta: { roleIds: parsed.data.roleIds, targetEmail: target.email }
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

// ----- lifecycle (plan L) -------------------------------------------------

// Suspend an active user: immediate lock-out (the per-request status
// re-check in auth/middleware enforces it). Reversible. Refuses to suspend
// yourself or the last active admin.
adminUsersRoute.post('/:id/suspend', requireCsrf, async (c) => {
  const actor = c.get('user')
  const target = await findById(c.env, c.req.param('id'))
  if (!target) return c.json({ error: 'not_found' }, 404)
  const guard = await guardRemovesAdminAccess(c, target, actor.userId, 'suspend')
  if (guard) return guard
  if (target.status !== 'suspended') await setUserStatus(c.env, target.id, 'suspended')
  // Instant MCP/CLI cutoff: kill every bearer/refresh token the user holds.
  const { revoked } = await revokeAllUserGrants(c.env, target.id)
  await audit(c.env, {
    actorId: actor.userId,
    action: 'user.suspend',
    target: target.id,
    meta: { from: target.status, targetEmail: target.email, revokedGrants: revoked }
  })
  return c.json({ revokedGrants: revoked })
})

// Reactivate (un-suspend) OR approve a pending user — both transition to
// `active`. Safe to re-enable, so no last-admin guard. Audited distinctly so
// the log shows "approve" for a pending→active vs "reactivate" otherwise.
adminUsersRoute.post('/:id/reactivate', requireCsrf, async (c) => {
  const actor = c.get('user')
  const target = await findById(c.env, c.req.param('id'))
  if (!target) return c.json({ error: 'not_found' }, 404)
  if (target.status !== 'active') await setUserStatus(c.env, target.id, 'active')
  await audit(c.env, {
    actorId: actor.userId,
    action: target.status === 'pending' ? 'user.approve' : 'user.reactivate',
    target: target.id,
    meta: { from: target.status, targetEmail: target.email }
  })
  return new Response(null, { status: 204 })
})

// Reject a pending user: removes the never-admitted row. Only valid while
// the user is `pending` (no authored content / memberships to clean up).
adminUsersRoute.post('/:id/reject', requireCsrf, async (c) => {
  const actor = c.get('user')
  const target = await findById(c.env, c.req.param('id'))
  if (!target) return c.json({ error: 'not_found' }, 404)
  if (target.status !== 'pending') {
    return c.json({ error: 'not_pending', hint: 'Only a pending user can be rejected.' }, 400)
  }
  await deleteUser(c.env, target.id, actor.userId)
  await audit(c.env, {
    actorId: actor.userId,
    action: 'user.reject',
    target: target.id,
    meta: { targetEmail: target.email }
  })
  return new Response(null, { status: 204 })
})

// Hard delete: removes the identity mirror, FK-cleans memberships/roles/
// credentials, de-attributes authored content, reassigns owned skills to the
// acting admin. Refuses self + last active admin. NOTE: if the identity is
// still on the env allowlist (or open_domain), they re-provision on next
// sign-in — see deleteUser.
adminUsersRoute.delete('/:id', requireCsrf, async (c) => {
  const actor = c.get('user')
  const target = await findById(c.env, c.req.param('id'))
  if (!target) return c.json({ error: 'not_found' }, 404)
  const guard = await guardRemovesAdminAccess(c, target, actor.userId, 'delete')
  if (guard) return guard
  // Revoke MCP/CLI tokens first (KV, keyed by user id) so access dies even if
  // a later step hiccups, then remove the D1 identity + its FK children.
  const { revoked } = await revokeAllUserGrants(c.env, target.id)
  const { reassignedSkills } = await deleteUser(c.env, target.id, actor.userId)
  await audit(c.env, {
    actorId: actor.userId,
    action: 'user.delete',
    target: target.id,
    meta: { targetEmail: target.email, idp: target.idp, reassignedSkills, revokedGrants: revoked }
  })
  return c.json({ reassignedSkills, revokedGrants: revoked })
})

/**
 * Block a deactivation/delete that would lock the org out: never act on
 * yourself, and never remove the last *active* admin.
 */
async function guardRemovesAdminAccess(
  c: Context<{ Bindings: Env; Variables: AuthedVariables }>,
  target: UserRow,
  actorId: string,
  verb: 'suspend' | 'delete'
): Promise<Response | null> {
  if (target.id === actorId) {
    return c.json({ error: `cannot_${verb}_self`, hint: `You can't ${verb} your own account.` }, 400)
  }
  if (target.role === 'admin' && (await countActiveAdmins(c.env, target.id)) < 1) {
    return c.json(
      { error: 'last_admin', hint: 'Promote another active admin first.' },
      400
    )
  }
  return null
}

function isForeignKeyViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /FOREIGN KEY constraint failed/i.test(msg)
}
