/**
 * Skills REST surface. Reads are open to any signed-in user (filtered
 * to `status='published'` for non-admins); writes are admin-only.
 *
 * Status gating happens here, not in the query layer: callers ask for
 * what they want and the route decides whether to filter. Keeps the
 * predicate co-located with the auth context.
 */

import { Hono } from 'hono'
import {
  CreateSkillRequest,
  DocContent,
  RestoreRequest,
  SkillTags,
  UpdateSkillRequest,
  type SkillAttachmentRef,
  type SkillDetail,
  type SkillRevisionSummary,
  type SkillSummary
} from '@ctxlayer/shared'
import type { Env } from '../env'
import { requireAdmin, requireUser, type AuthedVariables } from '../auth/middleware'
import { requireCsrf } from '../auth/csrf'
import {
  amendSkillRevision,
  createSkill,
  getHeadSkillRevision,
  getSkillById,
  getSkillRevision,
  listPublishedSkills,
  listSkillRevisions,
  listSkillsForAdmin,
  patchSkill,
  pruneAutosaveSkillRevisions,
  recordSkillRevision,
  sealSkillRevision,
  softDeleteSkill,
  type SkillRevisionRow,
  type SkillWithUsersRow
} from '../db/queries/skills'
import { decideRevision, MAX_RETAINED_AUTOSAVES } from '../db/revision-policy'
import { listAttachmentsForSkill } from '../db/queries/skill-attachments'
import { listTagsForSkill, replaceTagsForSkill } from '../db/queries/skill-tags'
import {
  contentDigest,
  deleteRevisionObjects,
  readRevision,
  readSnapshot,
  restoreFromRevision,
  writeRevisionAndSnapshot
} from '../storage/skills-r2'
import { audit } from '../audit/log'
import { lintSkillBody } from '../skills/schema-linter'

const CONTENT_MAX_BYTES = 2 * 1024 * 1024

export const skillsRoute = new Hono<{ Bindings: Env; Variables: AuthedVariables }>()
skillsRoute.use('*', requireUser)
skillsRoute.use('*', requireCsrf)

skillsRoute.get('/', async (c) => {
  const role = c.get('user').role
  const status = c.req.query('status') as 'draft' | 'published' | 'archived' | 'all' | undefined
  const rows =
    role === 'admin'
      ? await listSkillsForAdmin(c.env, { status })
      : await listPublishedSkills(c.env)
  const body: SkillSummary[] = rows.map(toSummary)
  return c.json(body)
})

skillsRoute.post('/', requireAdmin, async (c) => {
  const parsed = CreateSkillRequest.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'bad_request', issues: parsed.error.issues }, 400)
  const { userId } = c.get('user')
  try {
    const { content, ...meta } = parsed.data
    const row = await createSkill(c.env, { ...meta, createdBy: userId })
    // If the caller supplied an initial body (CLI draft-skill does),
    // persist a first revision now so the skill isn't empty on first
    // read.
    if (content) {
      const revisionId = newRevisionId()
      const put = await writeRevisionAndSnapshot(c.env, row.id, revisionId, content)
      await recordSkillRevision(c.env, {
        skillId: row.id,
        revisionId,
        authorId: userId,
        r2Key: put.key,
        byteSize: put.byteSize,
        contentHash: put.contentHash
      })
    }
    await audit(c.env, {
      actorId: userId,
      action: 'skill.create',
      target: row.id,
      meta: { draftedBy: parsed.data.drafterMeta ? 'cli' : 'manual' }
    })
    return c.json({ id: row.id, slug: row.slug }, 201)
  } catch (err) {
    if (isUniqueViolation(err)) return c.json({ error: 'slug_taken' }, 409)
    throw err
  }
})

skillsRoute.get('/:id', async (c) => {
  const id = c.req.param('id')
  const row = await getSkillById(c.env, id)
  if (!row) return c.json({ error: 'not_found' }, 404)
  if (!isVisibleToCaller(row, c.get('user').role)) return c.json({ error: 'not_found' }, 404)
  const [attachments, tags] = await Promise.all([
    listAttachmentsForSkill(c.env, id),
    listTagsForSkill(c.env, id)
  ])
  const body: SkillDetail = {
    ...toSummary(row),
    triggerText: row.trigger_text,
    currentRevId: row.current_rev_id,
    attachments: attachments.map(toAttachmentRef),
    tags,
    drafterMeta: parseDrafterMeta(row.drafter_meta)
  }
  return c.json(body)
})

skillsRoute.patch('/:id', requireAdmin, async (c) => {
  const id = c.req.param('id')
  if (!(await getSkillById(c.env, id))) return c.json({ error: 'not_found' }, 404)
  const parsed = UpdateSkillRequest.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'bad_request', issues: parsed.error.issues }, 400)
  try {
    await patchSkill(c.env, id, parsed.data)
    await audit(c.env, { actorId: c.get('user').userId, action: 'skill.patch', target: id })
    return new Response(null, { status: 204 })
  } catch (err) {
    if (isUniqueViolation(err)) return c.json({ error: 'slug_taken' }, 409)
    throw err
  }
})

skillsRoute.delete('/:id', requireAdmin, async (c) => {
  const id = c.req.param('id')
  if (!(await getSkillById(c.env, id))) return c.json({ error: 'not_found' }, 404)
  await softDeleteSkill(c.env, id)
  await audit(c.env, { actorId: c.get('user').userId, action: 'skill.delete', target: id })
  return new Response(null, { status: 204 })
})

skillsRoute.get('/:id/content', async (c) => {
  const id = c.req.param('id')
  const row = await getSkillById(c.env, id)
  if (!row) return c.json({ error: 'not_found' }, 404)
  if (!isVisibleToCaller(row, c.get('user').role)) return c.json({ error: 'not_found' }, 404)
  const content = (await readSnapshot(c.env, id)) ?? { blocks: [] }
  return c.json(content)
})

skillsRoute.put('/:id/content', requireAdmin, async (c) => {
  const id = c.req.param('id')
  const { userId } = c.get('user')
  if (!(await getSkillById(c.env, id))) return c.json({ error: 'not_found' }, 404)
  const raw = await c.req.arrayBuffer()
  if (raw.byteLength > CONTENT_MAX_BYTES) return c.json({ error: 'content_too_large' }, 413)
  const parsed = DocContent.safeParse(JSON.parse(new TextDecoder().decode(raw) || 'null'))
  if (!parsed.success) return c.json({ error: 'bad_request', issues: parsed.error.issues }, 400)

  // Autosave coalescing — same policy as docs (see db/revision-policy.ts).
  // `?mode=autosave` opts into coalescing; absent/explicit cuts a checkpoint.
  const explicit = c.req.query('mode') !== 'autosave'
  const { contentHash, byteSize } = await contentDigest(parsed.data)
  const head = await getHeadSkillRevision(c.env, id)
  const decision = decideRevision(head, {
    contentHash,
    userId,
    explicit,
    now: Math.floor(Date.now() / 1000)
  })

  // Dedup / seal: content unchanged. Skip the R2 write and the linter
  // (the body is byte-identical to what's already persisted + linted).
  if (decision.action === 'noop' || decision.action === 'seal') {
    if (decision.action === 'seal') await sealSkillRevision(c.env, id, decision.revisionId)
    return c.json({ revisionId: decision.revisionId, byteSize, contentHash, lintFindings: [] })
  }

  const revisionId = decision.action === 'amend' ? decision.revisionId : newRevisionId()
  const put = await writeRevisionAndSnapshot(c.env, id, revisionId, parsed.data)
  if (decision.action === 'amend') {
    await amendSkillRevision(c.env, {
      skillId: id,
      revisionId,
      byteSize: put.byteSize,
      contentHash: put.contentHash
    })
  } else {
    await recordSkillRevision(c.env, {
      skillId: id,
      revisionId,
      authorId: userId,
      r2Key: put.key,
      byteSize: put.byteSize,
      contentHash: put.contentHash,
      kind: decision.kind
    })
    // Retention: prune the oldest autosaves (D1) and drop their R2 bodies
    // after the response. Same policy as docs.
    const prunedKeys = await pruneAutosaveSkillRevisions(c.env, id, MAX_RETAINED_AUTOSAVES)
    if (prunedKeys.length > 0) {
      c.executionCtx.waitUntil(
        deleteRevisionObjects(c.env, prunedKeys).catch((err) =>
          console.error('autosave prune R2 cleanup failed', err)
        )
      )
    }
  }
  // Schema-reference linter runs after save. Warning-only — findings
  // ride along but don't block. Lint failures themselves never fail
  // the save (skill body is already persisted).
  let lintFindings: Awaited<ReturnType<typeof lintSkillBody>> = []
  try {
    lintFindings = await lintSkillBody(c.env, id, parsed.data)
  } catch (err) {
    console.error('skill linter failed (non-fatal):', err)
  }
  return c.json({
    revisionId,
    byteSize: put.byteSize,
    contentHash: put.contentHash,
    lintFindings
  })
})

skillsRoute.get('/:id/revisions', requireAdmin, async (c) => {
  const id = c.req.param('id')
  if (!(await getSkillById(c.env, id))) return c.json({ error: 'not_found' }, 404)
  const rows = await listSkillRevisions(c.env, id)
  const body: SkillRevisionSummary[] = rows.map(toRevisionSummary)
  return c.json(body)
})

skillsRoute.get('/:id/revisions/:rev/content', requireAdmin, async (c) => {
  const id = c.req.param('id')
  const rev = c.req.param('rev')
  if (!(await getSkillRevision(c.env, id, rev))) return c.json({ error: 'not_found' }, 404)
  const content = await readRevision(c.env, id, rev)
  if (!content) return c.json({ error: 'not_found' }, 404)
  return c.json(content)
})

// Restore mirrors docs.ts POST /:id/restore: copy a source revision's
// bytes to a fresh revision id + refresh the snapshot. No reindex enqueue
// (skill save lints instead of reindexing; the lint is skipped on restore
// since the body is just a verbatim copy of an already-saved revision).
skillsRoute.post('/:id/restore', requireAdmin, async (c) => {
  const id = c.req.param('id')
  const { userId } = c.get('user')
  if (!(await getSkillById(c.env, id))) return c.json({ error: 'not_found' }, 404)
  const parsed = RestoreRequest.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'bad_request', issues: parsed.error.issues }, 400)
  const sourceRev = await getSkillRevision(c.env, id, parsed.data.revisionId)
  if (!sourceRev) return c.json({ error: 'revision_not_found' }, 404)
  const newRevId = newRevisionId()
  const put = await restoreFromRevision(c.env, id, sourceRev.id, newRevId)
  if (!put) return c.json({ error: 'revision_body_missing' }, 410)
  await recordSkillRevision(c.env, {
    skillId: id,
    revisionId: newRevId,
    authorId: userId,
    r2Key: put.key,
    byteSize: put.byteSize,
    contentHash: put.contentHash
  })
  await audit(c.env, { actorId: userId, action: 'skill.restore', target: id })
  return c.json({ revisionId: newRevId })
})

// Inline /:id/tags endpoints; tags model is small enough not to
// warrant a separate router file.
skillsRoute.get('/:id/tags', async (c) => {
  const id = c.req.param('id')
  const row = await getSkillById(c.env, id)
  if (!row) return c.json({ error: 'not_found' }, 404)
  if (!isVisibleToCaller(row, c.get('user').role)) return c.json({ error: 'not_found' }, 404)
  const tags = await listTagsForSkill(c.env, id)
  return c.json(tags)
})

skillsRoute.put('/:id/tags', requireAdmin, async (c) => {
  const id = c.req.param('id')
  if (!(await getSkillById(c.env, id))) return c.json({ error: 'not_found' }, 404)
  const parsed = SkillTags.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'bad_request', issues: parsed.error.issues }, 400)
  await replaceTagsForSkill(c.env, id, parsed.data)
  return new Response(null, { status: 204 })
})

// ----- helpers ------------------------------------------------------------

function isVisibleToCaller(row: SkillWithUsersRow, role: string): boolean {
  if (role === 'admin') return true
  return row.status === 'published'
}

function toSummary(row: SkillWithUsersRow): SkillSummary {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isStale: row.is_stale === 1,
    createdBy: row.created_by
      ? {
          id: row.created_by,
          email: row.created_by_email ?? '',
          name: row.created_by_name
        }
      : null,
    updatedBy: row.updated_by_id
      ? {
          id: row.updated_by_id,
          email: row.updated_by_email ?? '',
          name: row.updated_by_name
        }
      : null
  }
}

function toRevisionSummary(row: SkillRevisionRow): SkillRevisionSummary {
  return {
    id: row.id,
    authorId: row.author_id,
    createdAt: row.created_at,
    byteSize: row.byte_size,
    contentHash: row.content_hash,
    kind: row.kind
  }
}

function toAttachmentRef(row: {
  upstream_id: string
  upstream_slug: string
  tool_name: string
}): SkillAttachmentRef {
  return {
    upstreamId: row.upstream_id,
    upstreamSlug: row.upstream_slug,
    toolName: row.tool_name
  }
}

function newRevisionId(): string {
  return crypto.randomUUID().replace(/-/g, '')
}

/**
 * Decode the JSON blob stored in skills.drafter_meta. Returns null if
 * the column is empty or unparseable so the SPA can render the
 * "Drafted by …" line conditionally without crashing on bad data.
 */
function parseDrafterMeta(s: string | null): unknown | null {
  if (!s) return null
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

function isUniqueViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /UNIQUE constraint failed/i.test(msg)
}
