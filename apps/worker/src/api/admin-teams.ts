/**
 * Admin CRUD for teams + team members. All routes gated by
 * `requireAdmin`. Member rows reference users(id); the route assumes
 * the calling admin has already used /api/users?email= to look up
 * the target id.
 */

import { Hono } from 'hono'
import { AddTeamMemberRequest, CreateTeamRequest, UpdateTeamRequest } from '@ctxlayer/shared'
import type { Env } from '../env'
import { requireAdmin, type AuthedVariables } from '../auth/middleware'
import { requireCsrf } from '../auth/csrf'
import { audit } from '../audit/log'
import {
  addTeamMember,
  createTeam,
  deleteTeam,
  getTeamById,
  listAdminTeams,
  listTeamMembers,
  patchTeam,
  removeTeamMember,
  toAdminTeamRow
} from '../db/queries/teams'
import { notFound, parseJsonBody } from './respond'
import { isUniqueViolation } from '../db/queries/util'

export const adminTeamsRoute = new Hono<{ Bindings: Env; Variables: AuthedVariables }>()
adminTeamsRoute.use('*', requireAdmin)
adminTeamsRoute.use('*', requireCsrf)

// Returns the admin-enriched shape — includes idp_group and managed_by_idp.
// The signed-in user endpoint at /api/teams still returns the slimmer
// TeamRef[] so IdP internals stay admin-scoped.
adminTeamsRoute.get('/', async (c) => c.json(await listAdminTeams(c.env)))

adminTeamsRoute.post('/', async (c) => {
  const parsed = await parseJsonBody(c, CreateTeamRequest)
  if (!parsed.ok) return parsed.res
  try {
    const row = await createTeam(c.env, parsed.data)
    await audit(c.env, {
      actorId: c.get('user').userId,
      action: 'team.create',
      target: row.id,
      meta: { slug: row.slug }
    })
    return c.json(toAdminTeamRow(row), 201)
  } catch (err) {
    if (isUniqueViolation(err)) return c.json({ error: 'slug_taken' }, 409)
    throw err
  }
})

adminTeamsRoute.patch('/:id', async (c) => {
  const id = c.req.param('id')
  if (!(await getTeamById(c.env, id))) return notFound(c)
  const parsed = await parseJsonBody(c, UpdateTeamRequest)
  if (!parsed.ok) return parsed.res
  try {
    await patchTeam(c.env, id, parsed.data)
    await audit(c.env, {
      actorId: c.get('user').userId,
      action: 'team.update',
      target: id,
      meta: { fields: Object.keys(parsed.data) }
    })
    return new Response(null, { status: 204 })
  } catch (err) {
    if (isUniqueViolation(err)) return c.json({ error: 'slug_taken' }, 409)
    throw err
  }
})

adminTeamsRoute.delete('/:id', async (c) => {
  const id = c.req.param('id')
  const row = await getTeamById(c.env, id)
  await deleteTeam(c.env, id)
  if (row) {
    await audit(c.env, {
      actorId: c.get('user').userId,
      action: 'team.delete',
      target: id,
      meta: { slug: row.slug }
    })
  }
  return new Response(null, { status: 204 })
})

// ----- members -----------------------------------------------------------

adminTeamsRoute.get('/:id/members', async (c) => {
  const id = c.req.param('id')
  if (!(await getTeamById(c.env, id))) return notFound(c)
  return c.json(await listTeamMembers(c.env, id))
})

adminTeamsRoute.post('/:id/members', async (c) => {
  const id = c.req.param('id')
  if (!(await getTeamById(c.env, id))) return notFound(c)
  const parsed = await parseJsonBody(c, AddTeamMemberRequest)
  if (!parsed.ok) return parsed.res
  await addTeamMember(c.env, id, parsed.data.userId, parsed.data.role ?? 'member')
  await audit(c.env, {
    actorId: c.get('user').userId,
    action: 'team.member_add',
    target: id,
    meta: { userId: parsed.data.userId, role: parsed.data.role ?? 'member' }
  })
  return new Response(null, { status: 204 })
})

adminTeamsRoute.delete('/:id/members/:userId', async (c) => {
  const id = c.req.param('id')
  const userId = c.req.param('userId')
  await removeTeamMember(c.env, id, userId)
  await audit(c.env, {
    actorId: c.get('user').userId,
    action: 'team.member_remove',
    target: id,
    meta: { userId }
  })
  return new Response(null, { status: 204 })
})
