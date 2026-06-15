/**
 * Docs REST surface. Reads are open to every signed-in user; writes go
 * through the per-doc ACL predicate in `db/queries/docs.ts`. The save
 * flow behind PUT /:id/content (revision coalescing + git divergence
 * flagging) lives in `docs-save-content.ts`.
 */

import { Hono } from 'hono'
import {
  CreateDocRequest,
  type DocDetail,
  type DocSummary,
  type RevisionSummary,
  RestoreRequest,
  SetLockedRequest,
  UpdateDocRequest
} from '@ctxlayer/shared'
import type { Env } from '../env'
import { requireUser, type AuthedVariables } from '../auth/middleware'
import { requireCsrf } from '../auth/csrf'
import {
  canEditDoc,
  canLockDoc,
  canShareDoc,
  clearDocLock,
  createDoc,
  editGateReason,
  getDocById,
  getRevision,
  listDocs,
  listRevisions,
  patchDoc,
  recordRevision,
  setDocLock,
  softDeleteDoc,
  type DocumentWithUsersRow,
  type EditBlockReason,
  type RevisionRow
} from '../db/queries/docs'
import { addDocTags } from '../db/queries/doc-tags'
import { composeOkfExport } from '../docs/okf'
import { audit } from '../audit/log'
import { saveDocContent } from './docs-save-content'
import {
  readRevision,
  readSnapshot,
  restoreFromRevision
} from '../storage/docs-r2'
import { notFound, parseJsonBody } from './respond'

export const docsRoute = new Hono<{ Bindings: Env; Variables: AuthedVariables }>()

docsRoute.use('*', requireUser)
docsRoute.use('*', requireCsrf)

docsRoute.get('/', async (c) => {
  const rows = await listDocs(c.env)
  const body: DocSummary[] = rows.map(toSummary)
  return c.json(body)
})

docsRoute.post('/', async (c) => {
  const parsed = await parseJsonBody(c, CreateDocRequest)
  if (!parsed.ok) return parsed.res
  const { userId } = c.get('user')
  const d = parsed.data
  const row = await createDoc(c.env, {
    title: d.title,
    slug: d.slug,
    kind: d.kind,
    folder: d.folder,
    createdBy: userId
  })
  // OKF metadata captured at import time. Applied after create so the doc
  // INSERT stays the common path; the rail then edits these in place.
  if (d.docType || d.description || d.resource || d.frontmatter) {
    await patchDoc(c.env, row.id, {
      docType: d.docType ?? null,
      description: d.description ?? null,
      resource: d.resource ?? null,
      okfFrontmatter: d.frontmatter ?? null
    })
  }
  if (d.tags?.length) await addDocTags(c.env, row.id, d.tags)
  return c.json({ id: row.id, slug: row.slug }, 201)
})

docsRoute.get('/:id', async (c) => {
  const id = c.req.param('id')
  const row = await getDocById(c.env, id)
  if (!row) return notFound(c)
  const { userId } = c.get('user')
  const [canEdit, canShare, canLock] = await Promise.all([
    canEditDoc(c.env, userId, id),
    canShareDoc(c.env, userId, id),
    canLockDoc(c.env, userId, id)
  ])
  const body: DocDetail = {
    ...toSummary(row),
    currentRevId: row.current_rev_id,
    docType: row.doc_type,
    description: row.description,
    resource: row.resource,
    canEdit,
    canShare,
    canLock
  }
  return c.json(body)
})

docsRoute.patch('/:id', async (c) => {
  const id = c.req.param('id')
  const { userId } = c.get('user')
  const blocked = await gateEdit(c.env, userId, id)
  if (blocked) return blocked
  const parsed = await parseJsonBody(c, UpdateDocRequest)
  if (!parsed.ok) return parsed.res
  await patchDoc(c.env, id, parsed.data)
  return new Response(null, { status: 204 })
})

docsRoute.delete('/:id', async (c) => {
  const id = c.req.param('id')
  const { userId } = c.get('user')
  const blocked = await gateEdit(c.env, userId, id)
  if (blocked) return blocked
  await softDeleteDoc(c.env, id)
  return new Response(null, { status: 204 })
})

// Download a doc as an OKF markdown file: synthesised `---` frontmatter
// (from the rail fields + preserved unknown keys) followed by the body.
// Open-read like the rest of the doc GETs.
docsRoute.get('/:id/export', async (c) => {
  const id = c.req.param('id')
  const out = await composeOkfExport(c.env, id)
  if (!out) return notFound(c)
  return new Response(out.markdown, {
    status: 200,
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': `attachment; filename="${out.filename}"`,
      'cache-control': 'no-store'
    }
  })
})

docsRoute.get('/:id/content', async (c) => {
  const id = c.req.param('id')
  const row = await getDocById(c.env, id)
  if (!row) return notFound(c)
  const content = (await readSnapshot(c.env, id)) ?? { blocks: [] }
  return c.json(content)
})

docsRoute.put('/:id/content', async (c) => {
  const id = c.req.param('id')
  const { userId } = c.get('user')
  const blocked = await gateEdit(c.env, userId, id)
  if (blocked) return blocked
  // `?mode=explicit` (absent → explicit, the safe default for older
  // clients) cuts a distinct checkpoint; autosaves coalesce. The full
  // save flow lives in docs-save-content.ts.
  const result = await saveDocContent(c.env, c.executionCtx, {
    docId: id,
    userId,
    raw: await c.req.arrayBuffer(),
    explicit: c.req.query('mode') !== 'autosave'
  })
  return c.json(result.body, result.status)
})

docsRoute.get('/:id/revisions', async (c) => {
  const id = c.req.param('id')
  if (!(await getDocById(c.env, id))) return notFound(c)
  const rows = await listRevisions(c.env, id)
  const body: RevisionSummary[] = rows.map(toRevisionSummary)
  return c.json(body)
})

docsRoute.get('/:id/revisions/:rev/content', async (c) => {
  const id = c.req.param('id')
  const rev = c.req.param('rev')
  if (!(await getRevision(c.env, id, rev))) return notFound(c)
  const content = await readRevision(c.env, id, rev)
  if (!content) return notFound(c)
  return c.json(content)
})

docsRoute.post('/:id/restore', async (c) => {
  const id = c.req.param('id')
  const { userId } = c.get('user')
  const blocked = await gateEdit(c.env, userId, id)
  if (blocked) return blocked
  const parsed = await parseJsonBody(c, RestoreRequest)
  if (!parsed.ok) return parsed.res
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

// ----- lock toggle --------------------------------------------------------

/**
 * PUT /api/docs/:id/lock with body `{ locked: boolean }`.
 *
 * Lock + unlock both gated by canLockDoc (admin or doc creator). The
 * lock predicate stays separate from the edit predicate per the
 * no-bypass design: locks can be cleared by the lock-permitted caller
 * even though they can't edit the locked doc.
 */
docsRoute.put('/:id/lock', async (c) => {
  const id = c.req.param('id')
  const { userId } = c.get('user')
  if (!(await canLockDoc(c.env, userId, id))) {
    return c.json({ error: 'forbidden' }, 403)
  }
  const parsed = await parseJsonBody(c, SetLockedRequest)
  if (!parsed.ok) return parsed.res
  if (parsed.data.locked) {
    await setDocLock(c.env, id, userId)
    await audit(c.env, { actorId: userId, action: 'doc.lock', target: id })
  } else {
    await clearDocLock(c.env, id)
    await audit(c.env, { actorId: userId, action: 'doc.unlock', target: id })
  }
  return new Response(null, { status: 204 })
})

// ----- edit-gate helper ---------------------------------------------------

/**
 * Used by every doc mutation route to short-circuit with the right
 * status code: 404 (no such doc), 423-Locked (doc is frozen), or
 * 403-Forbidden (caller lacks the access role). Returns null when
 * the caller can proceed.
 */
async function gateEdit(env: Env, userId: string, docId: string): Promise<Response | null> {
  const reason = await editGateReason(env, userId, docId)
  return reasonToResponse(reason)
}

function reasonToResponse(reason: EditBlockReason | null): Response | null {
  if (reason === null) return null
  if (reason === 'not_found') return jsonStatus({ error: 'not_found' }, 404)
  if (reason === 'locked') {
    return jsonStatus(
      {
        error: 'locked',
        hint: 'This doc is locked. Ask an admin or the doc creator to unlock it before editing.'
      },
      423
    )
  }
  return jsonStatus({ error: 'forbidden' }, 403)
}

function jsonStatus(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

// ----- shapers ------------------------------------------------------------

function toSummary(row: DocumentWithUsersRow): DocSummary {
  return {
    id: row.id,
    title: row.title,
    slug: row.slug,
    kind: row.kind,
    folder: row.folder,
    gitSourceId: row.git_source_id,
    gitSourceSlug: row.git_source_slug,
    gitSourceName: row.git_source_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lockedAt: row.locked_at,
    lockedBy: row.locked_by
      ? { id: row.locked_by, email: row.locked_by_email ?? '', name: row.locked_by_name }
      : null,
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
    contentHash: row.content_hash,
    kind: row.kind
  }
}

function newRevisionId(): string {
  return crypto.randomUUID().replace(/-/g, '')
}
