/**
 * Admin CRUD for invites (plan L admission). An invite pre-authorises an
 * email; a matching sign-in is admitted as `active`. All routes gated by
 * `requireAdmin` + router-wide `requireCsrf`; every mutation is audited.
 */

import { Hono } from 'hono'
import { CreateInvitesRequest } from '@ctxlayer/shared'
import type { Env } from '../env'
import { requireAdmin, type AuthedVariables } from '../auth/middleware'
import { requireCsrf } from '../auth/csrf'
import { audit } from '../audit/log'
import { createInvites, deleteInvite, listInvites } from '../db/queries/invites'

export const adminInvitesRoute = new Hono<{ Bindings: Env; Variables: AuthedVariables }>()
adminInvitesRoute.use('*', requireAdmin)
adminInvitesRoute.use('*', requireCsrf)

adminInvitesRoute.get('/', async (c) => c.json(await listInvites(c.env)))

// Accepts a single address or a pasted bulk list; server normalises +
// dedupes + skips known users/invites. Returns added/skipped/invalid counts.
adminInvitesRoute.post('/', async (c) => {
  const parsed = CreateInvitesRequest.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'bad_request', issues: parsed.error.issues }, 400)
  const result = await createInvites(c.env, parsed.data.emails, c.get('user').userId)
  await audit(c.env, {
    actorId: c.get('user').userId,
    action: 'invite.create',
    target: null,
    meta: { added: result.added, skipped: result.skipped, invalid: result.invalid.length }
  })
  return c.json(result, 201)
})

adminInvitesRoute.delete('/:id', async (c) => {
  const id = c.req.param('id')
  await deleteInvite(c.env, id)
  await audit(c.env, { actorId: c.get('user').userId, action: 'invite.delete', target: id })
  return new Response(null, { status: 204 })
})
