/**
 * D1 queries for documents + doc_revisions. ACL helpers (`canEdit`,
 * `canShare`) live here too because they're a property of the document
 * row and the calling user — keeping the predicate next to the rows it
 * gates avoids drift between routes and the (future) MCP layer.
 */

import type { Env } from '../../env'
import { slugifyBody, suggestSlug } from '@ctxlayer/shared'
import type { HeadRevision, RevisionKind } from '../revision-policy'

export interface DocumentRow {
  id: string
  title: string
  slug: string
  kind: 'doc' | 'prompt'
  // Folder path (`/specs/api/v2`) or null for root. Format validated
  // at the request layer (packages/shared/src/docs-types.ts).
  folder: string | null
  current_rev_id: string | null
  r2_snapshot: string | null
  created_by: string | null
  created_at: number
  updated_at: number
  deleted_at: number | null
  chunk_count: number
  // Lock state. Both NULL = unlocked. Both set = locked (pair always
  // moves together; isDocLocked / setDocLock / clearDocLock are the
  // only writers).
  locked_at: number | null
  locked_by: string | null
}

/**
 * `DocumentRow` joined with `users` twice: once for the original author
 * (created_by), once for the author of the latest revision (resolved
 * via current_rev_id → doc_revisions.author_id). Both nullable: a
 * freshly-created doc has no revisions yet; an author whose user row
 * was deleted produces NULL on either join.
 */
export interface DocumentWithUsersRow extends DocumentRow {
  git_source_id: string | null
  git_source_slug: string | null
  git_source_name: string | null
  created_by_email: string | null
  created_by_name: string | null
  updated_by_id: string | null
  updated_by_email: string | null
  updated_by_name: string | null
  locked_by_email: string | null
  locked_by_name: string | null
}

const SELECT_DOC_WITH_USERS = `
  SELECT d.id, d.title, d.slug, d.kind, d.folder, d.current_rev_id,
         d.r2_snapshot, d.created_by, d.created_at, d.updated_at,
         d.deleted_at, d.chunk_count,
         d.locked_at, d.locked_by, d.git_source_id,
         gs.slug         AS git_source_slug,
         gs.display_name AS git_source_name,
         cu.email AS created_by_email,
         cu.name  AS created_by_name,
         ru.id    AS updated_by_id,
         ru.email AS updated_by_email,
         ru.name  AS updated_by_name,
         lu.email AS locked_by_email,
         lu.name  AS locked_by_name
  FROM documents d
  LEFT JOIN users cu ON cu.id = d.created_by
  LEFT JOIN doc_revisions r ON r.id = d.current_rev_id
  LEFT JOIN users ru ON ru.id = r.author_id
  LEFT JOIN users lu ON lu.id = d.locked_by
  LEFT JOIN git_sources gs ON gs.id = d.git_source_id`

export interface RevisionRow {
  id: string
  doc_id: string
  author_id: string | null
  r2_key: string
  byte_size: number
  content_hash: string
  created_at: number
  kind: RevisionKind
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

async function getDocBySlug(env: Env, slug: string): Promise<DocumentWithUsersRow | null> {
  const row = await env.DB.prepare(
    `${SELECT_DOC_WITH_USERS}
     WHERE d.slug = ?1 AND d.deleted_at IS NULL`
  )
    .bind(slug)
    .first<DocumentWithUsersRow>()
  return row ?? null
}

/**
 * Resolve a doc by id first, then by slug. MCP surfaces (`get_doc`,
 * doc resources) accept either because `list_upstreams.attached_docs`
 * exposes both — an agent shouldn't have to know which it's holding.
 */
export async function getDocByIdOrSlug(
  env: Env,
  ref: string
): Promise<DocumentWithUsersRow | null> {
  return (await getDocById(env, ref)) ?? (await getDocBySlug(env, ref))
}

/**
 * Set the cached chunk_count after a successful reindex. Called by the
 * queue consumer so the next reindex knows how many chunks the
 * previous revision produced, which drives orphan cleanup in Vectorize.
 */
export async function updateChunkCount(env: Env, docId: string, count: number): Promise<void> {
  await env.DB.prepare(`UPDATE documents SET chunk_count = ?1 WHERE id = ?2`)
    .bind(count, docId)
    .run()
}

/**
 * Of the supplied doc ids, which are git-synced. Lets the search layer
 * keep git docs visible regardless of their team/product tag (search is
 * otherwise scope-filtered) without a chunk-metadata reindex. Empty
 * input → empty set (no query).
 */
export async function gitDocIdsAmong(env: Env, docIds: string[]): Promise<Set<string>> {
  if (docIds.length === 0) return new Set()
  const placeholders = docIds.map((_, i) => `?${i + 1}`).join(', ')
  const res = await env.DB.prepare(
    `SELECT id FROM documents WHERE git_source_id IS NOT NULL AND id IN (${placeholders})`
  )
    .bind(...docIds)
    .all<{ id: string }>()
  return new Set((res.results ?? []).map((r) => r.id))
}

/**
 * All non-deleted docs with just the fields the reindex-all admin action
 * needs to enqueue a reindex (git docs go via source.md, authored docs
 * via their current revision).
 */
export async function listDocsForReindex(env: Env): Promise<
  Array<{
    id: string
    current_rev_id: string | null
    git_source_id: string | null
    git_commit_sha: string | null
  }>
> {
  const res = await env.DB.prepare(
    `SELECT id, current_rev_id, git_source_id, git_commit_sha
     FROM documents WHERE deleted_at IS NULL`
  ).all<{
    id: string
    current_rev_id: string | null
    git_source_id: string | null
    git_commit_sha: string | null
  }>()
  return res.results ?? []
}

export interface CreateDocInput {
  title: string
  slug?: string
  kind?: 'doc' | 'prompt'
  folder?: string | null
  // Nullable: git-synced docs created by a source whose creator was
  // later deleted (ON DELETE SET NULL) carry no author. The column is
  // nullable + FK; binding null is valid.
  createdBy: string | null
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
  const folder = input.folder ?? null
  const baseSlug = input.slug ?? suggestSlug('doc', input.title)

  for (let attempt = 0; attempt < 4; attempt++) {
    const slug = attempt === 0 ? baseSlug : `${baseSlug}-${randomSuffix()}`
    try {
      await env.DB.prepare(
        `INSERT INTO documents (id, title, slug, kind, folder, created_by, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`
      )
        .bind(id, input.title, slug, kind, folder, input.createdBy, now)
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
  // slug intentionally omitted: doc slugs are immutable after creation.
  kind?: 'doc' | 'prompt'
  // `null` moves the doc to root; `undefined` leaves folder unchanged.
  folder?: string | null
}

export async function patchDoc(env: Env, id: string, patch: PatchDocInput): Promise<void> {
  const fields: string[] = []
  const binds: unknown[] = []
  if (patch.title !== undefined) {
    fields.push(`title = ?${fields.length + 1}`)
    binds.push(patch.title)
  }
  if (patch.kind !== undefined) {
    fields.push(`kind = ?${fields.length + 1}`)
    binds.push(patch.kind)
  }
  if (patch.folder !== undefined) {
    fields.push(`folder = ?${fields.length + 1}`)
    binds.push(patch.folder)
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

// ----- folder tree + rename ----------------------------------------------

/**
 * Rename a folder (and every nested folder). Returns the list of doc
 * ids that were affected — caller uses this for audit metadata and
 * the SPA refresh signal.
 */
export async function renameFolderPrefix(
  env: Env,
  oldPath: string,
  newPath: string
): Promise<string[]> {
  if (oldPath === newPath) return []
  const now = Math.floor(Date.now() / 1000)
  // Affected: folder == oldPath OR folder LIKE oldPath || '/%'
  const affectedRes = await env.DB.prepare(
    `SELECT id, folder FROM documents
     WHERE deleted_at IS NULL
       AND (folder = ?1 OR folder LIKE ?1 || '/%')`
  )
    .bind(oldPath)
    .all<{ id: string; folder: string }>()
  const rows = affectedRes.results ?? []
  if (rows.length === 0) return []
  const stmts = rows.map((r) => {
    const nextFolder =
      r.folder === oldPath ? newPath : `${newPath}${r.folder.slice(oldPath.length)}`
    return env.DB.prepare(
      `UPDATE documents SET folder = ?1, updated_at = ?2
       WHERE id = ?3 AND deleted_at IS NULL`
    ).bind(nextFolder, now, r.id)
  })
  await env.DB.batch(stmts)
  return rows.map((r) => r.id)
}

/**
 * Find every doc id that lives in the given folder OR under any
 * sub-folder. Powers the "can the caller edit all of these?" check
 * for folder rename, plus the "is this folder empty?" check for
 * delete.
 */
export async function listDocIdsInFolder(env: Env, path: string): Promise<string[]> {
  const res = await env.DB.prepare(
    `SELECT id FROM documents
     WHERE deleted_at IS NULL
       AND (folder = ?1 OR folder LIKE ?1 || '/%')`
  )
    .bind(path)
    .all<{ id: string }>()
  return (res.results ?? []).map((r) => r.id)
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
  // Defaults to 'explicit'. Autosaves pass 'autosave' so the next one can
  // coalesce into this row (see db/revision-policy.ts).
  kind?: RevisionKind
}

/**
 * Insert a new revision row and bump the parent doc's current_rev_id +
 * r2_snapshot + updated_at. Two statements; D1 doesn't expose
 * transactions but writes to a single row from the same Worker
 * request are sequentially consistent.
 */
export async function recordRevision(env: Env, input: RecordRevisionInput): Promise<RevisionRow> {
  const now = Math.floor(Date.now() / 1000)
  // Atomic: the revision INSERT and the head/snapshot UPDATE land together as
  // one D1 transaction, so a crash can't leave a revision row without a head
  // pointer (or a head pointing at a revision that never inserted).
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO doc_revisions
         (id, doc_id, author_id, r2_key, byte_size, content_hash, created_at, kind)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
    ).bind(
      input.revisionId,
      input.docId,
      input.authorId,
      input.r2Key,
      input.byteSize,
      input.contentHash,
      now,
      input.kind ?? 'explicit'
    ),
    env.DB.prepare(
      `UPDATE documents SET current_rev_id = ?1, r2_snapshot = ?2, updated_at = ?3 WHERE id = ?4`
    ).bind(input.revisionId, input.r2Key, now, input.docId)
  ])
  const row = await env.DB.prepare(
    `SELECT id, doc_id, author_id, r2_key, byte_size, content_hash, created_at, kind
     FROM doc_revisions WHERE id = ?1`
  )
    .bind(input.revisionId)
    .first<RevisionRow>()
  if (!row) throw new Error('revision_insert_lost')
  return row
}

/**
 * The doc's current head revision (its `current_rev_id` row), or null if
 * it has none yet. Backs the autosave-coalescing decision: the policy
 * folds an autosave into this row when it's an open, same-author,
 * in-window autosave. Returns only the fields the policy needs.
 */
export async function getHeadRevision(env: Env, docId: string): Promise<HeadRevision | null> {
  const row = await env.DB.prepare(
    `SELECT r.id, r.author_id, r.content_hash, r.created_at, r.kind
     FROM documents d
     JOIN doc_revisions r ON r.id = d.current_rev_id
     WHERE d.id = ?1 AND d.deleted_at IS NULL`
  )
    .bind(docId)
    .first<{
      id: string
      author_id: string | null
      content_hash: string
      created_at: number
      kind: RevisionKind
    }>()
  if (!row) return null
  return {
    id: row.id,
    authorId: row.author_id,
    contentHash: row.content_hash,
    createdAt: row.created_at,
    kind: row.kind
  }
}

/**
 * Overwrite the rolling autosave head in place: refresh its byte_size +
 * content_hash (the R2 object was already overwritten at the same revision
 * id) and bump the parent doc's updated_at. created_at stays put — it's
 * the coalesce-window anchor, so the row ages out after the window even
 * under continuous typing. current_rev_id / r2_snapshot are unchanged
 * (same revision id).
 */
export async function amendRevision(
  env: Env,
  input: { docId: string; revisionId: string; byteSize: number; contentHash: string }
): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `UPDATE doc_revisions SET byte_size = ?1, content_hash = ?2 WHERE id = ?3`
  )
    .bind(input.byteSize, input.contentHash, input.revisionId)
    .run()
  await env.DB.prepare(`UPDATE documents SET updated_at = ?1 WHERE id = ?2`)
    .bind(now, input.docId)
    .run()
}

/**
 * Promote a head autosave revision to 'explicit' — the user clicked Save
 * on content identical to the rolling autosave. Freezes it as a checkpoint
 * so the next autosave cuts a new row instead of overwriting this one.
 */
export async function sealRevision(env: Env, docId: string, revisionId: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  await env.DB.prepare(`UPDATE doc_revisions SET kind = 'explicit' WHERE id = ?1`)
    .bind(revisionId)
    .run()
  await env.DB.prepare(`UPDATE documents SET updated_at = ?1 WHERE id = ?2`)
    .bind(now, docId)
    .run()
}

/**
 * Retention prune: delete all but the `keep` most-recent autosave
 * revisions for a doc, returning the R2 keys of the deleted rows so the
 * caller can drop their bodies. Explicit revisions are never touched, and
 * the doc's current head is always spared (it may be the rolling autosave
 * holding live content). Two statements (select victims → delete by id) so
 * the freed R2 keys come back without relying on DELETE … RETURNING.
 */
export async function pruneAutosaveRevisions(
  env: Env,
  docId: string,
  keep: number
): Promise<string[]> {
  const headRow = await env.DB.prepare(`SELECT current_rev_id FROM documents WHERE id = ?1`)
    .bind(docId)
    .first<{ current_rev_id: string | null }>()
  const headId = headRow?.current_rev_id ?? ''
  const victims = await env.DB.prepare(
    `SELECT id, r2_key FROM doc_revisions
     WHERE doc_id = ?1 AND kind = 'autosave' AND id != ?2
       AND id NOT IN (
         SELECT id FROM doc_revisions
         WHERE doc_id = ?1 AND kind = 'autosave'
         ORDER BY created_at DESC, id DESC
         LIMIT ?3
       )`
  )
    .bind(docId, headId, keep)
    .all<{ id: string; r2_key: string }>()
  const rows = victims.results ?? []
  if (rows.length === 0) return []
  const ids = rows.map((r) => r.id)
  const placeholders = ids.map((_, i) => `?${i + 1}`).join(', ')
  await env.DB.prepare(`DELETE FROM doc_revisions WHERE id IN (${placeholders})`)
    .bind(...ids)
    .run()
  return rows.map((r) => r.r2_key)
}

export async function listRevisions(env: Env, docId: string): Promise<RevisionRow[]> {
  const res = await env.DB.prepare(
    `SELECT id, doc_id, author_id, r2_key, byte_size, content_hash, created_at, kind
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
    `SELECT id, doc_id, author_id, r2_key, byte_size, content_hash, created_at, kind
     FROM doc_revisions WHERE doc_id = ?1 AND id = ?2`
  )
    .bind(docId, revisionId)
    .first<RevisionRow>()
  return row ?? null
}

// ----- access predicates -------------------------------------------------

/**
 * Caller can EDIT a doc iff (a) they have the access role AND (b) the
 * doc isn't locked. Per the lock design (M5 phase-3 side feature),
 * locks block edits for everyone — admin + creator included. To edit
 * a locked doc, call `clearDocLock` first via the lock endpoint.
 *
 * Implemented as one query: the UNION ALL builds the access predicate,
 * the outer SELECT only returns a hit when documents.locked_at IS NULL.
 */
export async function canEditDoc(env: Env, userId: string, docId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS hit
     FROM documents d
     WHERE d.id = ?2
       AND d.deleted_at IS NULL
       AND d.locked_at IS NULL
       AND EXISTS (
         SELECT 1 FROM users WHERE id = ?1 AND role = 'admin'
         UNION ALL
         SELECT 1 FROM documents WHERE id = ?2 AND created_by = ?1 AND deleted_at IS NULL
         UNION ALL
         SELECT 1 FROM doc_editors WHERE doc_id = ?2 AND scope_kind = 'user' AND scope_id = ?1
         UNION ALL
         SELECT 1 FROM doc_editors WHERE doc_id = ?2 AND scope_kind = 'everyone' AND scope_id = ''
       )
     LIMIT 1`
  )
    .bind(userId, docId)
    .first<{ hit: number }>()
  return !!row
}

/**
 * Caller can MANAGE SHARING iff: admin or author. Granted editors do
 * NOT re-grant; this keeps the permission graph one-hop deep.
 *
 * NOTE: sharing is intentionally NOT lock-gated. Per the lock design
 * choice, locks freeze content/title/tags but admins should still be
 * able to revoke access on a locked doc.
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

/**
 * Caller can LOCK / UNLOCK iff: admin or doc creator. Same role-set
 * as canShareDoc (both are "doc-owner-class" operations) but kept
 * as a separate function so the predicates can drift later without
 * confusing the sharing path.
 */
export async function canLockDoc(env: Env, userId: string, docId: string): Promise<boolean> {
  return canShareDoc(env, userId, docId)
}

// ----- lock state ---------------------------------------------------------

export async function isDocLocked(env: Env, docId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT locked_at FROM documents WHERE id = ?1 AND deleted_at IS NULL`
  )
    .bind(docId)
    .first<{ locked_at: number | null }>()
  return !!(row && row.locked_at !== null)
}

/**
 * One-shot edit-gate predicate: returns null when the caller can
 * edit, otherwise the *reason*. Lets route handlers emit a
 * distinguished 423-Locked vs 403-Forbidden status without
 * duplicating two D1 reads per route.
 */
export type EditBlockReason = 'not_found' | 'locked' | 'forbidden'

export async function editGateReason(
  env: Env,
  userId: string,
  docId: string
): Promise<EditBlockReason | null> {
  // Combine doc existence + lock check + access role check into a
  // single round-trip. The `flags` row tells us which gate (if any)
  // is closed.
  const row = await env.DB.prepare(
    `SELECT
       (SELECT 1 FROM documents WHERE id = ?2 AND deleted_at IS NULL) AS exists_flag,
       (SELECT locked_at FROM documents WHERE id = ?2 AND deleted_at IS NULL) AS locked_at,
       EXISTS (
         SELECT 1 FROM users WHERE id = ?1 AND role = 'admin'
         UNION ALL
         SELECT 1 FROM documents WHERE id = ?2 AND created_by = ?1 AND deleted_at IS NULL
         UNION ALL
         SELECT 1 FROM doc_editors WHERE doc_id = ?2 AND scope_kind = 'user' AND scope_id = ?1
         UNION ALL
         SELECT 1 FROM doc_editors WHERE doc_id = ?2 AND scope_kind = 'everyone' AND scope_id = ''
       ) AS has_role`
  )
    .bind(userId, docId)
    .first<{ exists_flag: number | null; locked_at: number | null; has_role: number }>()
  if (!row || !row.exists_flag) return 'not_found'
  if (!row.has_role) return 'forbidden'
  if (row.locked_at !== null) return 'locked'
  return null
}

/**
 * Apply a lock. Idempotent: a re-lock just refreshes locked_at +
 * locked_by. Caller has already passed canLockDoc.
 */
export async function setDocLock(env: Env, docId: string, byUserId: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `UPDATE documents SET locked_at = ?1, locked_by = ?2, updated_at = ?3
     WHERE id = ?4 AND deleted_at IS NULL`
  )
    .bind(now, byUserId, now, docId)
    .run()
}

export async function clearDocLock(env: Env, docId: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `UPDATE documents SET locked_at = NULL, locked_by = NULL, updated_at = ?1
     WHERE id = ?2 AND deleted_at IS NULL`
  )
    .bind(now, docId)
    .run()
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

// Slug BODY for a doc title (no `doc-` prefix). Thin wrapper over the
// shared canonical slugifier so the worker, SPA, and CLI stay in lockstep.
// Callers that need the full create-time slug use `suggestSlug('doc', …)`.
export function slugify(title: string): string {
  return slugifyBody(title, 90)
}

function isUniqueViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /UNIQUE constraint failed/i.test(msg)
}
