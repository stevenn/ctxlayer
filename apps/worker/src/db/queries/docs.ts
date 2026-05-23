/**
 * D1 queries for documents + doc_revisions. ACL helpers (`canEdit`,
 * `canShare`) live here too because they're a property of the document
 * row and the calling user — keeping the predicate next to the rows it
 * gates avoids drift between routes and the (future) MCP layer.
 */

import type { Env } from '../../env'

export interface DocumentRow {
  id: string
  title: string
  slug: string
  kind: 'doc' | 'prompt'
  current_rev_id: string | null
  r2_snapshot: string | null
  created_by: string | null
  created_at: number
  updated_at: number
  deleted_at: number | null
}

/**
 * `DocumentRow` joined with `users` twice: once for the original author
 * (created_by), once for the author of the latest revision (resolved
 * via current_rev_id → doc_revisions.author_id). Both nullable: a
 * freshly-created doc has no revisions yet; an author whose user row
 * was deleted produces NULL on either join.
 */
export interface DocumentWithUsersRow extends DocumentRow {
  created_by_email: string | null
  created_by_name: string | null
  updated_by_id: string | null
  updated_by_email: string | null
  updated_by_name: string | null
}

const SELECT_DOC_WITH_USERS = `
  SELECT d.id, d.title, d.slug, d.kind, d.current_rev_id, d.r2_snapshot,
         d.created_by, d.created_at, d.updated_at, d.deleted_at,
         cu.email AS created_by_email,
         cu.name  AS created_by_name,
         ru.id    AS updated_by_id,
         ru.email AS updated_by_email,
         ru.name  AS updated_by_name
  FROM documents d
  LEFT JOIN users cu ON cu.id = d.created_by
  LEFT JOIN doc_revisions r ON r.id = d.current_rev_id
  LEFT JOIN users ru ON ru.id = r.author_id`

export interface RevisionRow {
  id: string
  doc_id: string
  author_id: string | null
  r2_key: string
  byte_size: number
  content_hash: string
  created_at: number
}

export async function listDocs(env: Env): Promise<DocumentWithUsersRow[]> {
  const res = await env.DB.prepare(
    `${SELECT_DOC_WITH_USERS}
     WHERE d.deleted_at IS NULL
     ORDER BY d.updated_at DESC`
  ).all<DocumentWithUsersRow>()
  return res.results ?? []
}

export async function getDocById(env: Env, id: string): Promise<DocumentWithUsersRow | null> {
  const row = await env.DB.prepare(
    `${SELECT_DOC_WITH_USERS}
     WHERE d.id = ?1 AND d.deleted_at IS NULL`
  )
    .bind(id)
    .first<DocumentWithUsersRow>()
  return row ?? null
}

export interface CreateDocInput {
  title: string
  slug?: string
  kind?: 'doc' | 'prompt'
  createdBy: string
}

/**
 * Create a new doc. If `slug` is omitted we slugify the title and
 * append a 6-char suffix on collision (up to 3 retries before giving
 * up). Returns the created row or throws on persistent collision.
 */
export async function createDoc(env: Env, input: CreateDocInput): Promise<DocumentRow> {
  const id = newId()
  const now = Math.floor(Date.now() / 1000)
  const kind = input.kind ?? 'doc'
  const baseSlug = input.slug ?? slugify(input.title)

  for (let attempt = 0; attempt < 4; attempt++) {
    const slug = attempt === 0 ? baseSlug : `${baseSlug}-${randomSuffix()}`
    try {
      await env.DB.prepare(
        `INSERT INTO documents (id, title, slug, kind, created_by, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`
      )
        .bind(id, input.title, slug, kind, input.createdBy, now)
        .run()
      const row = await getDocById(env, id)
      if (!row) throw new Error('doc_insert_lost')
      return row
    } catch (err) {
      if (isUniqueViolation(err) && attempt < 3) continue
      throw err
    }
  }
  throw new Error('doc_slug_collision_persistent')
}

export interface PatchDocInput {
  title?: string
  slug?: string
  kind?: 'doc' | 'prompt'
}

export async function patchDoc(env: Env, id: string, patch: PatchDocInput): Promise<void> {
  const fields: string[] = []
  const binds: unknown[] = []
  if (patch.title !== undefined) {
    fields.push(`title = ?${fields.length + 1}`)
    binds.push(patch.title)
  }
  if (patch.slug !== undefined) {
    fields.push(`slug = ?${fields.length + 1}`)
    binds.push(patch.slug)
  }
  if (patch.kind !== undefined) {
    fields.push(`kind = ?${fields.length + 1}`)
    binds.push(patch.kind)
  }
  fields.push(`updated_at = ?${fields.length + 1}`)
  binds.push(Math.floor(Date.now() / 1000))
  binds.push(id)
  await env.DB.prepare(
    `UPDATE documents SET ${fields.join(', ')} WHERE id = ?${binds.length} AND deleted_at IS NULL`
  )
    .bind(...binds)
    .run()
}

export async function softDeleteDoc(env: Env, id: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  await env.DB.prepare(`UPDATE documents SET deleted_at = ?1 WHERE id = ?2`).bind(now, id).run()
}

export interface RecordRevisionInput {
  docId: string
  revisionId: string
  authorId: string
  r2Key: string
  byteSize: number
  contentHash: string
}

/**
 * Insert a new revision row and bump the parent doc's current_rev_id +
 * r2_snapshot + updated_at. Two statements; D1 doesn't expose
 * transactions but writes to a single row from the same Worker
 * request are sequentially consistent.
 */
export async function recordRevision(env: Env, input: RecordRevisionInput): Promise<RevisionRow> {
  const now = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO doc_revisions (id, doc_id, author_id, r2_key, byte_size, content_hash, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
  )
    .bind(input.revisionId, input.docId, input.authorId, input.r2Key, input.byteSize, input.contentHash, now)
    .run()
  await env.DB.prepare(
    `UPDATE documents SET current_rev_id = ?1, r2_snapshot = ?2, updated_at = ?3 WHERE id = ?4`
  )
    .bind(input.revisionId, input.r2Key, now, input.docId)
    .run()
  const row = await env.DB.prepare(
    `SELECT id, doc_id, author_id, r2_key, byte_size, content_hash, created_at
     FROM doc_revisions WHERE id = ?1`
  )
    .bind(input.revisionId)
    .first<RevisionRow>()
  if (!row) throw new Error('revision_insert_lost')
  return row
}

export async function listRevisions(env: Env, docId: string): Promise<RevisionRow[]> {
  const res = await env.DB.prepare(
    `SELECT id, doc_id, author_id, r2_key, byte_size, content_hash, created_at
     FROM doc_revisions WHERE doc_id = ?1 ORDER BY created_at DESC LIMIT 100`
  )
    .bind(docId)
    .all<RevisionRow>()
  return res.results ?? []
}

export async function getRevision(
  env: Env,
  docId: string,
  revisionId: string
): Promise<RevisionRow | null> {
  const row = await env.DB.prepare(
    `SELECT id, doc_id, author_id, r2_key, byte_size, content_hash, created_at
     FROM doc_revisions WHERE doc_id = ?1 AND id = ?2`
  )
    .bind(docId, revisionId)
    .first<RevisionRow>()
  return row ?? null
}

// ----- access predicates -------------------------------------------------

/**
 * Caller can EDIT a doc iff: admin, or author, or has an explicit
 * 'user' grant, or there's an 'everyone' grant on the doc.
 * Implemented as one query so the route doesn't fan out into four.
 */
export async function canEditDoc(env: Env, userId: string, docId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS hit FROM (
       SELECT 1 FROM users WHERE id = ?1 AND role = 'admin'
       UNION ALL
       SELECT 1 FROM documents WHERE id = ?2 AND created_by = ?1 AND deleted_at IS NULL
       UNION ALL
       SELECT 1 FROM doc_editors WHERE doc_id = ?2 AND scope_kind = 'user' AND scope_id = ?1
       UNION ALL
       SELECT 1 FROM doc_editors WHERE doc_id = ?2 AND scope_kind = 'everyone' AND scope_id = ''
     ) LIMIT 1`
  )
    .bind(userId, docId)
    .first<{ hit: number }>()
  return !!row
}

/**
 * Caller can MANAGE SHARING iff: admin or author. Granted editors do
 * NOT re-grant; this keeps the permission graph one-hop deep.
 */
export async function canShareDoc(env: Env, userId: string, docId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS hit FROM (
       SELECT 1 FROM users WHERE id = ?1 AND role = 'admin'
       UNION ALL
       SELECT 1 FROM documents WHERE id = ?2 AND created_by = ?1 AND deleted_at IS NULL
     ) LIMIT 1`
  )
    .bind(userId, docId)
    .first<{ hit: number }>()
  return !!row
}

// ----- helpers -----------------------------------------------------------

function newId(): string {
  return crypto.randomUUID().replace(/-/g, '')
}

function randomSuffix(): string {
  const buf = new Uint8Array(3)
  crypto.getRandomValues(buf)
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .normalize('NFKD')
      // Strip combining diacritic marks NFKD just produced (e.g. é -> e + ́).
      // Without this, `é` becomes `e` plus a combining acute which the
      // next regex treats as a non-allowed char and replaces with '-'.
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 90) || 'untitled'
  )
}

function isUniqueViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /UNIQUE constraint failed/i.test(msg)
}
