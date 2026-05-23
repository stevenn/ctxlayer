/**
 * Per-document ACL routes. Only the author and admins can manage
 * sharing (`canShareDoc`); granted editors do not re-grant. This keeps
 * the permission graph one-hop deep and avoids "share storm" bugs.
 */

import { Hono } from 'hono'
import {
  AddEditorRequest,
  type DocEditorsResponse,
  DocEditorScope
} from '@ctxlayer/shared'
import type { Env } from '../env'
import { requireUser, type AuthedVariables } from '../auth/middleware'
import { requireCsrf } from '../auth/csrf'
import { canShareDoc, getDocById } from '../db/queries/docs'
import {
  addEveryoneEditor,
  addUserEditor,
  listEditors,
  removeEveryoneEditor,
  removeUserEditor
} from '../db/queries/doc-editors'

export const docSharingRoute = new Hono<{ Bindings: Env; Variables: AuthedVariables }>()

docSharingRoute.use('*', requireUser)
docSharingRoute.use('*', requireCsrf)

docSharingRoute.get('/:id/editors', async (c) => {
  const id = c.req.param('id')
  if (!(await getDocById(c.env, id))) return c.json({ error: 'not_found' }, 404)
  const view = await listEditors(c.env, id)
  const body: DocEditorsResponse = {
    users: view.users.map((u) => ({ userId: u.user_id, email: u.email, name: u.name })),
    everyone: view.everyone
  }
  return c.json(body)
})

docSharingRoute.post('/:id/editors', async (c) => {
  const id = c.req.param('id')
  const { userId } = c.get('user')
  if (!(await canShareDoc(c.env, userId, id))) return c.json({ error: 'forbidden' }, 403)
  const parsed = AddEditorRequest.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'bad_request', issues: parsed.error.issues }, 400)
  if (parsed.data.kind === 'user') {
    await addUserEditor(c.env, id, parsed.data.userId, userId)
  } else {
    await addEveryoneEditor(c.env, id, userId)
  }
  return new Response(null, { status: 204 })
})

docSharingRoute.delete('/:id/editors/:scope/:scopeId', async (c) => {
  const id = c.req.param('id')
  const { userId } = c.get('user')
  if (!(await canShareDoc(c.env, userId, id))) return c.json({ error: 'forbidden' }, 403)
  const scope = DocEditorScope.safeParse(c.req.param('scope'))
  if (!scope.success) return c.json({ error: 'bad_scope' }, 400)
  if (scope.data === 'user') {
    await removeUserEditor(c.env, id, c.req.param('scopeId'))
  } else {
    await removeEveryoneEditor(c.env, id)
  }
  return new Response(null, { status: 204 })
})
