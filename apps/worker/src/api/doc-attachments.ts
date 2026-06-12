/**
 * Doc ↔ upstream(.tool) attachment management. Symmetric with
 * skill-attachments. Reads are open (existing doc visibility = every
 * signed-in user); writes are admin-only.
 */

import { Hono } from 'hono'
import { AttachDocRequest } from '@ctxlayer/shared'
import type { Env } from '../env'
import { requireAdmin, requireUser, type AuthedVariables } from '../auth/middleware'
import { requireCsrf } from '../auth/csrf'
import { attachDoc, detachDoc, listAttachmentsForDoc } from '../db/queries/doc-attachments'
import { getDocById } from '../db/queries/docs'
import { getUpstreamById } from '../db/queries/upstreams'
import { audit } from '../audit/log'
import { notFound, parseJsonBody } from './respond'

export const docAttachmentsRoute = new Hono<{ Bindings: Env; Variables: AuthedVariables }>()
docAttachmentsRoute.use('*', requireUser)
docAttachmentsRoute.use('*', requireCsrf)

docAttachmentsRoute.get('/', async (c) => {
  const docId = c.req.query('docId')
  if (!docId) return c.json({ error: 'missing_doc_id' }, 400)
  if (!(await getDocById(c.env, docId))) return notFound(c)
  const rows = await listAttachmentsForDoc(c.env, docId)
  return c.json(
    rows.map((r) => ({
      upstreamId: r.upstream_id,
      upstreamSlug: r.upstream_slug,
      toolName: r.tool_name
    }))
  )
})

docAttachmentsRoute.post('/', requireAdmin, async (c) => {
  const parsed = await parseJsonBody(c, AttachDocRequest)
  if (!parsed.ok) return parsed.res
  const { docId, upstreamId, toolName } = parsed.data
  const [doc, upstream] = await Promise.all([
    getDocById(c.env, docId),
    getUpstreamById(c.env, upstreamId)
  ])
  if (!doc || !upstream) return notFound(c)
  const actor = c.get('user')
  await attachDoc(c.env, { docId, upstreamId, toolName, createdBy: actor.userId })
  await audit(c.env, {
    actorId: actor.userId,
    action: 'doc.attach',
    target: docId,
    meta: { upstreamId, toolName: toolName ?? '' }
  })
  return new Response(null, { status: 204 })
})

docAttachmentsRoute.delete('/', requireAdmin, async (c) => {
  const parsed = await parseJsonBody(c, AttachDocRequest)
  if (!parsed.ok) return parsed.res
  const { docId, upstreamId, toolName } = parsed.data
  await detachDoc(c.env, { docId, upstreamId, toolName })
  await audit(c.env, {
    actorId: c.get('user').userId,
    action: 'doc.detach',
    target: docId,
    meta: { upstreamId, toolName: toolName ?? '' }
  })
  return new Response(null, { status: 204 })
})
