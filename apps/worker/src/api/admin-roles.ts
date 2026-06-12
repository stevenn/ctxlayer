/**
 * Admin CRUD for org roles (engineering, qa, product, …). All routes
 * gated by `requireAdmin` + `requireCsrf`. Membership is assigned
 * per-user on the Users page (PUT /api/admin/users/:id/roles), not here —
 * the roles drawer only edits the role record itself. Mirrors
 * admin-teams.ts.
 */

import { Hono } from 'hono'
import { CreateRoleRequest, UpdateRoleRequest } from '@ctxlayer/shared'
import type { Env } from '../env'
import { requireAdmin, type AuthedVariables } from '../auth/middleware'
import { requireCsrf } from '../auth/csrf'
import { audit } from '../audit/log'
import {
  createRole,
  deleteRole,
  getRoleById,
  listAdminRoles,
  patchRole,
  toRoleRef
} from '../db/queries/roles'
import { notFound, parseJsonBody } from './respond'
import { isUniqueViolation } from '../db/queries/util'

export const adminRolesRoute = new Hono<{ Bindings: Env; Variables: AuthedVariables }>()
adminRolesRoute.use('*', requireAdmin)
adminRolesRoute.use('*', requireCsrf)

adminRolesRoute.get('/', async (c) => c.json(await listAdminRoles(c.env)))

adminRolesRoute.post('/', async (c) => {
  const parsed = await parseJsonBody(c, CreateRoleRequest)
  if (!parsed.ok) return parsed.res
  try {
    const row = await createRole(c.env, parsed.data)
    await audit(c.env, {
      actorId: c.get('user').userId,
      action: 'role.create',
      target: row.id,
      meta: { slug: parsed.data.slug }
    })
    return c.json(toRoleRef(row), 201)
  } catch (err) {
    if (isUniqueViolation(err)) return c.json({ error: 'slug_taken' }, 409)
    throw err
  }
})

adminRolesRoute.patch('/:id', async (c) => {
  const id = c.req.param('id')
  if (!(await getRoleById(c.env, id))) return notFound(c)
  const parsed = await parseJsonBody(c, UpdateRoleRequest)
  if (!parsed.ok) return parsed.res
  try {
    await patchRole(c.env, id, parsed.data)
    await audit(c.env, {
      actorId: c.get('user').userId,
      action: 'role.update',
      target: id,
      meta: { fields: Object.keys(parsed.data) }
    })
    return new Response(null, { status: 204 })
  } catch (err) {
    if (isUniqueViolation(err)) return c.json({ error: 'slug_taken' }, 409)
    throw err
  }
})

adminRolesRoute.delete('/:id', async (c) => {
  const id = c.req.param('id')
  const row = await getRoleById(c.env, id)
  await deleteRole(c.env, id)
  if (row) {
    await audit(c.env, {
      actorId: c.get('user').userId,
      action: 'role.delete',
      target: id,
      meta: { slug: row.slug }
    })
  }
  return new Response(null, { status: 204 })
})
