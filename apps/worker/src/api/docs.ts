/**
 * Docs REST surface. Reads are open to every signed-in user; writes go
 * through the per-doc ACL predicate in `db/queries/docs.ts`.
 *
 * Save flow (PUT /content):
 *   1. canEdit check
 *   2. write revision + snapshot to R2 (revision first, so a partial
 *      failure preserves the old snapshot)
 *   3. INSERT doc_revisions + UPDATE documents.current_rev_id
 *   4. waitUntil-enqueue {docId, revisionId} to DOC_REINDEX_QUEUE
 *      (consumer is ack-only in M2a, real reindex lands in M2b)
 */

import { Hono } from 'hono'
import {
  CreateDocRequest,
  DocContent,
  type DocDetail,
  type DocSummary,
  type RevisionSummary,
  RestoreRequest,
  UpdateDocRequest
} from '@ctxlayer/shared'
import type { Env } from '../env'
import { requireUser, type AuthedVariables } from '../auth/middleware'
import { requireCsrf } from '../auth/csrf'
import {
  canEditDoc,
  canShareDoc,
  createDoc,
  getDocById,
  getRevision,
  listDocs,
  listRevisions,
  patchDoc,
  recordRevision,
  softDeleteDoc,
  type DocumentWithUsersRow,
  type RevisionRow
} from '../db/queries/docs'
import {
  readRevision,
  readSnapshot,
  restoreFromRevision,
  writeRevisionAndSnapshot
} from '../storage/docs-r2'

const CONTENT_MAX_BYTES = 2 * 1024 * 1024

export const docsRoute = new Hono<{ Bindings: Env; Variables: AuthedVariables }>()

docsRoute.use('*', requireUser)
docsRoute.use('*', requireCsrf)

docsRoute.get('/', async (c) => {
  const rows = await listDocs(c.env)
  const body: DocSummary[] = rows.map(toSummary)
  return c.json(body)
})

docsRoute.post('/', async (c) => {
  const parsed = CreateDocRequest.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'bad_request', issues: parsed.error.issues }, 400)
  const { userId } = c.get('user')
  const row = await createDoc(c.env, { ...parsed.data, createdBy: userId })
  return c.json({ id: row.id, slug: row.slug }, 201)
})

docsRoute.get('/:id', async (c) => {
  const id = c.req.param('id')
  const row = await getDocById(c.env, id)
  if (!row) return c.json({ error: 'not_found' }, 404)
  const { userId } = c.get('user')
  const [canEdit, canShare] = await Promise.all([
    canEditDoc(c.env, userId, id),
    canShareDoc(c.env, userId, id)
  ])
  const body: DocDetail = { ...toSummary(row), currentRevId: row.current_rev_id, canEdit, canShare }
  return c.json(body)
})

docsRoute.patch('/:id', async (c) => {
  const id = c.req.param('id')
  const { userId } = c.get('user')
  if (!(await canEditDoc(c.env, userId, id))) return c.json({ error: 'forbidden' }, 403)
  const parsed = UpdateDocRequest.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'bad_request', issues: parsed.error.issues }, 400)
  await patchDoc(c.env, id, parsed.data)
  return new Response(null, { status: 204 })
})

docsRoute.delete('/:id', async (c) => {
  const id = c.req.param('id')
  const { userId } = c.get('user')
  if (!(await canEditDoc(c.env, userId, id))) return c.json({ error: 'forbidden' }, 403)
  await softDeleteDoc(c.env, id)
  return new Response(null, { status: 204 })
})

docsRoute.get('/:id/content', async (c) => {
  const id = c.req.param('id')
  const row = await getDocById(c.env, id)
  if (!row) return c.json({ error: 'not_found' }, 404)
  const content = (await readSnapshot(c.env, id)) ?? { blocks: [] }
  return c.json(content)
})

docsRoute.put('/:id/content', async (c) => {
  const id = c.req.param('id')
  const { userId } = c.get('user')
  if (!(await canEditDoc(c.env, userId, id))) return c.json({ error: 'forbidden' }, 403)
  const raw = await c.req.arrayBuffer()
  if (raw.byteLength > CONTENT_MAX_BYTES) return c.json({ error: 'content_too_large' }, 413)
  const parsed = DocContent.safeParse(JSON.parse(new TextDecoder().decode(raw) || 'null'))
  if (!parsed.success) return c.json({ error: 'bad_request', issues: parsed.error.issues }, 400)
  const revisionId = newRevisionId()
  const put = await writeRevisionAndSnapshot(c.env, id, revisionId, parsed.data)
  await recordRevision(c.env, {
    docId: id,
    revisionId,
    authorId: userId,
    r2Key: put.key,
    byteSize: put.byteSize,
    contentHash: put.contentHash
  })
  c.executionCtx.waitUntil(
    c.env.DOC_REINDEX_QUEUE.send({ docId: id, revisionId }).catch((err) =>
      console.error('reindex enqueue failed', err)
    )
  )
  return c.json({ revisionId, byteSize: put.byteSize, contentHash: put.contentHash })
})

docsRoute.get('/:id/revisions', async (c) => {
  const id = c.req.param('id')
  if (!(await getDocById(c.env, id))) return c.json({ error: 'not_found' }, 404)
  const rows = await listRevisions(c.env, id)
  const body: RevisionSummary[] = rows.map(toRevisionSummary)
  return c.json(body)
})

docsRoute.get('/:id/revisions/:rev/content', async (c) => {
  const id = c.req.param('id')
  const rev = c.req.param('rev')
  if (!(await getRevision(c.env, id, rev))) return c.json({ error: 'not_found' }, 404)
  const content = await readRevision(c.env, id, rev)
  if (!content) return c.json({ error: 'not_found' }, 404)
  return c.json(content)
})

docsRoute.post('/:id/restore', async (c) => {
  const id = c.req.param('id')
  const { userId } = c.get('user')
  if (!(await canEditDoc(c.env, userId, id))) return c.json({ error: 'forbidden' }, 403)
  const parsed = RestoreRequest.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'bad_request', issues: parsed.error.issues }, 400)
  const sourceRev = await getRevision(c.env, id, parsed.data.revisionId)
  if (!sourceRev) return c.json({ error: 'revision_not_found' }, 404)
  const newRevId = newRevisionId()
  const put = await restoreFromRevision(c.env, id, sourceRev.id, newRevId)
  if (!put) return c.json({ error: 'revision_body_missing' }, 410)
  await recordRevision(c.env, {
    docId: id,
    revisionId: newRevId,
    authorId: userId,
    r2Key: put.key,
    byteSize: put.byteSize,
    contentHash: put.contentHash
  })
  c.executionCtx.waitUntil(
    c.env.DOC_REINDEX_QUEUE.send({ docId: id, revisionId: newRevId }).catch((err) =>
      console.error('reindex enqueue failed', err)
    )
  )
  return c.json({ revisionId: newRevId })
})

// ----- shapers ------------------------------------------------------------

function toSummary(row: DocumentWithUsersRow): DocSummary {
  return {
    id: row.id,
    title: row.title,
    slug: row.slug,
    kind: row.kind,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by
      ? { id: row.created_by, email: row.created_by_email ?? '', name: row.created_by_name }
      : null,
    // updatedBy is null until the doc has at least one revision. We
    // do NOT fall back to createdBy here so the SPA can decide how to
    // render the "never edited" case (and so a non-creator save shows
    // up unambiguously).
    updatedBy: row.updated_by_id
      ? { id: row.updated_by_id, email: row.updated_by_email ?? '', name: row.updated_by_name }
      : null
  }
}

function toRevisionSummary(row: RevisionRow): RevisionSummary {
  return {
    id: row.id,
    authorId: row.author_id,
    createdAt: row.created_at,
    byteSize: row.byte_size,
    contentHash: row.content_hash
  }
}

function newRevisionId(): string {
  return crypto.randomUUID().replace(/-/g, '')
}
