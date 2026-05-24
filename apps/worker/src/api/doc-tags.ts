/**
 * Doc tag routes. GET is signed-in only (tags are public metadata,
 * not ACL). PUT requires canEdit on the doc — same predicate as
 * content writes.
 *
 * On a successful PUT we fire a reindex message for the doc's
 * current revision so Vectorize metadata is rebuilt. Reuse of the
 * existing pipeline keeps the code path single: the consumer
 * reads doc_tags as part of upsertChunks input.
 */

import { Hono } from 'hono'
import { DocTags } from '@ctxlayer/shared'
import type { Env } from '../env'
import { requireUser, type AuthedVariables } from '../auth/middleware'
import { requireCsrf } from '../auth/csrf'
import { canEditDoc, getDocById } from '../db/queries/docs'
import { listTagsForDoc, replaceTagsForDoc } from '../db/queries/doc-tags'

export const docTagsRoute = new Hono<{ Bindings: Env; Variables: AuthedVariables }>()

docTagsRoute.use('*', requireUser)
docTagsRoute.use('*', requireCsrf)

docTagsRoute.get('/:id/tags', async (c) => {
  const id = c.req.param('id')
  if (!(await getDocById(c.env, id))) return c.json({ error: 'not_found' }, 404)
  const tags = await listTagsForDoc(c.env, id)
  return c.json(tags)
})

docTagsRoute.put('/:id/tags', async (c) => {
  const id = c.req.param('id')
  const { userId } = c.get('user')
  if (!(await canEditDoc(c.env, userId, id))) return c.json({ error: 'forbidden' }, 403)
  const parsed = DocTags.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'bad_request', issues: parsed.error.issues }, 400)
  await replaceTagsForDoc(c.env, id, parsed.data)

  // Fire reindex for the current revision so Vectorize metadata is
  // refreshed. Tag-only changes don't touch R2 but the consumer
  // re-reads tags via doc_tags at upsert time.
  const doc = await getDocById(c.env, id)
  if (doc?.current_rev_id) {
    c.executionCtx.waitUntil(
      c.env.DOC_REINDEX_QUEUE.send({ docId: id, revisionId: doc.current_rev_id }).catch((err) =>
        console.error('reindex enqueue on tag change failed', err)
      )
    )
  }
  return new Response(null, { status: 204 })
})
