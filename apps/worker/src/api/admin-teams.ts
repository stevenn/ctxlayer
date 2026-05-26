/**
 * Admin CRUD for teams + team members. All routes gated by
 * `requireAdmin`. Member rows reference users(id); the route assumes
 * the calling admin has already used /api/users?email= to look up
 * the target id.
 */

import { Hono } from 'hono'
import {
  AddTeamMemberRequest,
  CreateTeamRequest,
  UpdateTeamRequest
} from '@ctxlayer/shared'
import type { Env } from '../env'
import { requireAdmin, type AuthedVariables } from '../auth/middleware'
import { requireCsrf } from '../auth/csrf'
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

export const adminTeamsRoute = new Hono<{ Bindings: Env; Variables: AuthedVariables }>()
adminTeamsRoute.use('*', requireAdmin)
adminTeamsRoute.use('*', requireCsrf)

// Returns the admin-enriched shape — includes idp_group and managed_by_idp.
// The signed-in user endpoint at /api/teams still returns the slimmer
// TeamRef[] so IdP internals stay admin-scoped.
adminTeamsRoute.get('/', async (c) => c.json(await listAdminTeams(c.env)))

adminTeamsRoute.post('/', async (c) => {
  const parsed = CreateTeamRequest.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'bad_request', issues: parsed.error.issues }, 400)
  try {
    const row = await createTeam(c.env, parsed.data)
    return c.json(toAdminTeamRow(row), 201)
  } catch (err) {
    if (isUniqueViolation(err)) return c.json({ error: 'slug_taken' }, 409)
    throw err
  }
})

adminTeamsRoute.patch('/:id', async (c) => {
  const id = c.req.param('id')
  if (!(await getTeamById(c.env, id))) return c.json({ error: 'not_found' }, 404)
  const parsed = UpdateTeamRequest.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'bad_request', issues: parsed.error.issues }, 400)
  try {
    await patchTeam(c.env, id, parsed.data)
    return new Response(null, { status: 204 })
  } catch (err) {
    if (isUniqueViolation(err)) return c.json({ error: 'slug_taken' }, 409)
    throw err
  }
})

adminTeamsRoute.delete('/:id', async (c) => {
  const id = c.req.param('id')
  await deleteTeam(c.env, id)
  return new Response(null, { status: 204 })
})

// ----- members -----------------------------------------------------------

adminTeamsRoute.get('/:id/members', async (c) => {
  const id = c.req.param('id')
  if (!(await getTeamById(c.env, id))) return c.json({ error: 'not_found' }, 404)
  return c.json(await listTeamMembers(c.env, id))
})

adminTeamsRoute.post('/:id/members', async (c) => {
  const id = c.req.param('id')
  if (!(await getTeamById(c.env, id))) return c.json({ error: 'not_found' }, 404)
  const parsed = AddTeamMemberRequest.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'bad_request', issues: parsed.error.issues }, 400)
  await addTeamMember(c.env, id, parsed.data.userId, parsed.data.role ?? 'member')
  return new Response(null, { status: 204 })
})

adminTeamsRoute.delete('/:id/members/:userId', async (c) => {
  const id = c.req.param('id')
  const userId = c.req.param('userId')
  await removeTeamMember(c.env, id, userId)
  return new Response(null, { status: 204 })
})

function isUniqueViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /UNIQUE constraint failed/i.test(msg)
}
