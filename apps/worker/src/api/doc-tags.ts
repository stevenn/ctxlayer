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
import { editGateReason, getDocById } from '../db/queries/docs'
import { listTagsForDoc, replaceTagsForDoc } from '../db/queries/doc-tags'
import { notFound, parseJsonBody } from './respond'

export const docTagsRoute = new Hono<{ Bindings: Env; Variables: AuthedVariables }>()

docTagsRoute.use('*', requireUser)
docTagsRoute.use('*', requireCsrf)

docTagsRoute.get('/:id/tags', async (c) => {
  const id = c.req.param('id')
  if (!(await getDocById(c.env, id))) return notFound(c)
  const tags = await listTagsForDoc(c.env, id)
  return c.json(tags)
})

docTagsRoute.put('/:id/tags', async (c) => {
  const id = c.req.param('id')
  const { userId } = c.get('user')
  // Same gate as the doc body endpoints: 404 / 423-Locked / 403.
  // Tag edits are part of the "frozen surface" when a doc is locked
  // (per the lock-scope design choice).
  const reason = await editGateReason(c.env, userId, id)
  if (reason === 'not_found') return notFound(c)
  if (reason === 'locked') {
    return c.json(
      { error: 'locked', hint: 'This doc is locked; tags cannot be edited until unlock.' },
      423
    )
  }
  if (reason === 'forbidden') return c.json({ error: 'forbidden' }, 403)
  const parsed = await parseJsonBody(c, DocTags)
  if (!parsed.ok) return parsed.res
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
