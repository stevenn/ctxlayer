/**
 * D1 queries for documents + doc_revisions. ACL helpers (`canEdit`,
 * `canShare`) live here too because they're a property of the document
 * row and the calling user — keeping the predicate next to the rows it
 * gates avoids drift between routes and the (future) MCP layer.
 */

import type { Env } from '../../env'
import { slugifyBody, suggestSlug } from '@ctxlayer/shared'
import type { HeadRevision, RevisionKind } from '../revision-policy'
import { buildPatchUpdate, isUniqueViolation, newId, randomSuffix } from './util'
import { makeRevisionQueries } from './revision-queries'

export interface DocumentRow {
  id: string
  title: string
  slug: string
  // Folder path (`/specs/api/v2`) or null for root. Format validated
  // at the request layer (packages/shared/src/docs-types.ts).
  folder: string | null
  // OKF frontmatter fields (migration 0025). All nullable.
  doc_type: string | null
  description: string | null
  resource: string | null
  current_rev_id: string | null
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
  SELECT d.id, d.title, d.slug, d.folder,
         d.doc_type, d.description, d.resource, d.current_rev_id,
         d.created_by, d.created_at, d.updated_at,
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

/**
 * The fields the OKF export + write-back need: the rail-editable frontmatter
 * columns, the preserved raw block (unknown-key carry-through), the git
 * origin + sync state (so a clean git doc exports its verbatim source.md
 * body rather than a lossy blocks render), and updated_at for the OKF
 * `timestamp`. One flat read, no joins.
 */
export interface DocOkfExportRow {
  id: string
  title: string
  slug: string
  folder: string | null
  doc_type: string | null
  description: string | null
  resource: string | null
  okf_frontmatter: string | null
  updated_at: number
  git_source_id: string | null
  git_sync_state: string | null
}

export async function getDocForOkfExport(env: Env, id: string): Promise<DocOkfExportRow | null> {
  const row = await env.DB.prepare(
    `SELECT ${OKF_EXPORT_COLS} FROM documents WHERE id = ?1 AND deleted_at IS NULL`
  )
    .bind(id)
    .first<DocOkfExportRow>()
  return row ?? null
}

const OKF_EXPORT_COLS = `id, title, slug, folder, doc_type, description, resource,
  okf_frontmatter, updated_at, git_source_id, git_sync_state`

// A folder root of '' or '/' means the whole library; otherwise the bundle is
// the root folder and its descendants.
function folderScope(root: string): { clause: string; binds: string[] } {
  if (root === '' || root === '/') return { clause: '', binds: [] }
  return { clause: ` AND (folder = ?1 OR folder LIKE ?1 || '/%')`, binds: [root] }
}

/** OKF export rows for every doc under a bundle root (folder subtree). */
export async function listDocOkfExportsUnderFolder(
  env: Env,
  root: string
): Promise<DocOkfExportRow[]> {
  const scope = folderScope(root)
  const res = await env.DB.prepare(
    `SELECT ${OKF_EXPORT_COLS} FROM documents
     WHERE deleted_at IS NULL${scope.clause}
     ORDER BY folder, slug`
  )
    .bind(...scope.binds)
    .all<DocOkfExportRow>()
  return res.results ?? []
}

/** Explicit revisions under a bundle root, newest first — feeds the bundle log.md. */
export async function listBundleLogEntries(
  env: Env,
  root: string
): Promise<Array<{ created_at: number; title: string }>> {
  const scope = folderScope(root)
  // folderScope's clause names `folder`; qualify it for the joined alias.
  const clause = scope.clause.replace(/folder/g, 'd.folder')
  const res = await env.DB.prepare(
    `SELECT r.created_at AS created_at, d.title AS title
     FROM doc_revisions r JOIN documents d ON d.id = r.doc_id
     WHERE d.deleted_at IS NULL AND r.kind = 'explicit'${clause}
     ORDER BY r.created_at DESC LIMIT 200`
  )
    .bind(...scope.binds)
    .all<{ created_at: number; title: string }>()
  return res.results ?? []
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
 * The slim per-doc state the reindex consumer needs: title (embedded in
 * every chunk), the previous chunk_count (Vectorize orphan cleanup), and
 * the last successfully-indexed content hash (skip-unchanged check).
 * Deliberately NOT the 5-join `getDocById` — the consumer reads this on
 * every queue message.
 */
export interface DocReindexState {
  id: string
  title: string
  chunk_count: number
  last_indexed_hash: string | null
}

export async function getDocReindexState(env: Env, docId: string): Promise<DocReindexState | null> {
  const row = await env.DB.prepare(
    `SELECT id, title, chunk_count, last_indexed_hash
     FROM documents WHERE id = ?1 AND deleted_at IS NULL`
  )
    .bind(docId)
    .first<DocReindexState>()
  return row ?? null
}

/**
 * Record the outcome of a successful reindex: the cached chunk_count
 * (so the next reindex knows the previous high-water mark for orphan
 * cleanup in Vectorize) and the content hash that produced it (so an
 * unchanged doc can skip the pipeline entirely). Called by the queue
 * consumer only after the Vectorize upsert succeeded.
 */
export async function setDocIndexedState(
  env: Env,
  docId: string,
  count: number,
  contentHash: string
): Promise<void> {
  await env.DB.prepare(
    `UPDATE documents SET chunk_count = ?1, last_indexed_hash = ?2 WHERE id = ?3`
  )
    .bind(count, contentHash, docId)
    .run()
}

/**
 * Slug + title for a set of doc ids in one round trip. Backs the search
 * result grouper, which only needs the link fields — not the 5-join
 * `getDocById` row. Deleted docs are filtered out so search results
 * never link to a 404.
 */
export async function listDocRefs(
  env: Env,
  docIds: string[]
): Promise<Array<{ id: string; slug: string; title: string }>> {
  if (docIds.length === 0) return []
  const placeholders = docIds.map((_, i) => `?${i + 1}`).join(', ')
  const res = await env.DB.prepare(
    `SELECT id, slug, title FROM documents
     WHERE id IN (${placeholders}) AND deleted_at IS NULL`
  )
    .bind(...docIds)
    .all<{ id: string; slug: string; title: string }>()
  return res.results ?? []
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
  const folder = input.folder ?? null
  const baseSlug = input.slug ?? suggestSlug('doc', input.title)

  for (let attempt = 0; attempt < 4; attempt++) {
    const slug = attempt === 0 ? baseSlug : `${baseSlug}-${randomSuffix()}`
    try {
      await env.DB.prepare(
        `INSERT INTO documents (id, title, slug, folder, created_by, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`
      )
        .bind(id, input.title, slug, folder, input.createdBy, now)
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
  // `null` moves the doc to root; `undefined` leaves folder unchanged.
  folder?: string | null
  // OKF frontmatter fields. `null` clears, `undefined` leaves unchanged.
  docType?: string | null
  description?: string | null
  resource?: string | null
  // Raw imported frontmatter block (unknown-key preservation). Internal —
  // set by git sync / import, never exposed on UpdateDocRequest.
  okfFrontmatter?: string | null
}

export async function patchDoc(env: Env, id: string, patch: PatchDocInput): Promise<void> {
  // allowEmpty: an empty patch still bumps updated_at (pre-existing behavior).
  const update = buildPatchUpdate(
    'documents',
    {
      title: patch.title,
      folder: patch.folder,
      doc_type: patch.docType,
      description: patch.description,
      resource: patch.resource,
      okf_frontmatter: patch.okfFrontmatter
    },
    id,
    { andWhere: 'deleted_at IS NULL', allowEmpty: true }
  )
  if (!update) return
  await env.DB.prepare(update.sql)
    .bind(...update.binds)
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

// The doc-side instantiation of the shared revision machinery. Semantics
// (atomic record, coalescing head, head-sparing prune) are documented on
// the factory members in revision-queries.ts. Exported for the shared
// save pipeline (api/revision-save.ts); routes use the named delegates.
export const docRevisionQueries = makeRevisionQueries<RevisionRow>({
  parentTable: 'documents',
  revisionTable: 'doc_revisions',
  fkColumn: 'doc_id',
  insertLostError: 'revision_insert_lost'
})

export function recordRevision(env: Env, input: RecordRevisionInput): Promise<RevisionRow> {
  return docRevisionQueries.record(env, {
    parentId: input.docId,
    revisionId: input.revisionId,
    authorId: input.authorId,
    r2Key: input.r2Key,
    byteSize: input.byteSize,
    contentHash: input.contentHash,
    kind: input.kind
  })
}

export function getHeadRevision(env: Env, docId: string): Promise<HeadRevision | null> {
  return docRevisionQueries.head(env, docId)
}

export function amendRevision(
  env: Env,
  input: { docId: string; revisionId: string; byteSize: number; contentHash: string }
): Promise<void> {
  return docRevisionQueries.amend(env, {
    parentId: input.docId,
    revisionId: input.revisionId,
    byteSize: input.byteSize,
    contentHash: input.contentHash
  })
}

export function sealRevision(env: Env, docId: string, revisionId: string): Promise<void> {
  return docRevisionQueries.seal(env, docId, revisionId)
}

export function pruneAutosaveRevisions(env: Env, docId: string, keep: number): Promise<string[]> {
  return docRevisionQueries.pruneAutosaves(env, docId, keep)
}

export function listRevisions(env: Env, docId: string): Promise<RevisionRow[]> {
  return docRevisionQueries.list(env, docId)
}

export function getRevision(
  env: Env,
  docId: string,
  revisionId: string
): Promise<RevisionRow | null> {
  return docRevisionQueries.get(env, docId, revisionId)
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

// Slug BODY for a doc title (no `doc-` prefix). Thin wrapper over the
// shared canonical slugifier so the worker, SPA, and CLI stay in lockstep.
// Callers that need the full create-time slug use `suggestSlug('doc', …)`.
export function slugify(title: string): string {
  return slugifyBody(title, 90)
}
