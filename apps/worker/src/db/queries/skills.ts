/**
 * D1 queries for `skills` + `skill_revisions`. Mirrors `docs.ts` in
 * shape but with skills-specific differences:
 *   - no folder / lock / per-skill ACL (open-read for any signed-in
 *     user, admin-write only)
 *   - status gate: drafts + archived are admin-only on read paths
 *   - no chunk count (skills aren't indexed into Vectorize in v1)
 *
 * The single MCP layer reads via `listSkillsForReader` /
 * `getSkillBySlug` which already apply the status filter for non-admin
 * callers; SPA admin routes use `listSkillsForAdmin` to see drafts.
 */

import type { Env } from '../../env'
import { suggestSlug } from '@ctxlayer/shared'
import type { HeadRevision, RevisionKind } from '../revision-policy'

export interface SkillRow {
  id: string
  slug: string
  title: string
  description: string
  trigger_text: string
  status: 'draft' | 'published' | 'archived'
  current_rev_id: string | null
  r2_snapshot: string | null
  drafter_meta: string | null
  created_by: string | null
  created_at: number
  updated_at: number
  deleted_at: number | null
}

export interface SkillWithUsersRow extends SkillRow {
  created_by_email: string | null
  created_by_name: string | null
  updated_by_id: string | null
  updated_by_email: string | null
  updated_by_name: string | null
  // M8: 1 if any attached tool's input_schema_hash changed after this
  // skill's updated_at. 0 otherwise. Computed at read time via EXISTS
  // subquery; no persisted column needed.
  is_stale: number
}

const SELECT_SKILL_WITH_USERS = `
  SELECT s.id, s.slug, s.title, s.description, s.trigger_text, s.status,
         s.current_rev_id, s.r2_snapshot, s.drafter_meta, s.created_by,
         s.created_at, s.updated_at, s.deleted_at,
         cu.email AS created_by_email,
         cu.name  AS created_by_name,
         ru.id    AS updated_by_id,
         ru.email AS updated_by_email,
         ru.name  AS updated_by_name,
         (
           SELECT 1 FROM skill_attachments sa
           JOIN upstream_tools ut
             ON ut.upstream_id = sa.upstream_id
            AND ut.tool_name   = sa.tool_name
           WHERE sa.skill_id = s.id
             AND sa.tool_name != ''
             AND ut.last_schema_change_at IS NOT NULL
             AND ut.last_schema_change_at > s.updated_at
           LIMIT 1
         ) AS is_stale
  FROM skills s
  LEFT JOIN users cu ON cu.id = s.created_by
  LEFT JOIN skill_revisions r ON r.id = s.current_rev_id
  LEFT JOIN users ru ON ru.id = r.author_id`

export interface SkillRevisionRow {
  id: string
  skill_id: string
  author_id: string | null
  r2_key: string
  byte_size: number
  content_hash: string
  created_at: number
  kind: RevisionKind
}

/**
 * Reader-facing list: published only, ordered by updated_at DESC.
 * Backs MCP `list_skills` and the CLI `pull` export.
 */
export async function listPublishedSkills(env: Env): Promise<SkillWithUsersRow[]> {
  const res = await env.DB.prepare(
    `${SELECT_SKILL_WITH_USERS}
     WHERE s.deleted_at IS NULL AND s.status = 'published'
     ORDER BY s.updated_at DESC`
  ).all<SkillWithUsersRow>()
  return res.results ?? []
}

/**
 * Admin-facing list. Defaults to draft + published (excludes archived
 * unless explicitly requested). Used by /app/admin/skills.
 */
export async function listSkillsForAdmin(
  env: Env,
  opts: { status?: 'draft' | 'published' | 'archived' | 'all' } = {}
): Promise<SkillWithUsersRow[]> {
  const status = opts.status ?? 'active'
  let where = `s.deleted_at IS NULL`
  if (status === 'draft') where += ` AND s.status = 'draft'`
  else if (status === 'published') where += ` AND s.status = 'published'`
  else if (status === 'archived') where += ` AND s.status = 'archived'`
  else if (status === 'all') {
    /* no extra filter */
  } else {
    where += ` AND s.status IN ('draft', 'published')`
  }
  const res = await env.DB.prepare(
    `${SELECT_SKILL_WITH_USERS} WHERE ${where} ORDER BY s.updated_at DESC`
  ).all<SkillWithUsersRow>()
  return res.results ?? []
}

export async function getSkillById(env: Env, id: string): Promise<SkillWithUsersRow | null> {
  const row = await env.DB.prepare(
    `${SELECT_SKILL_WITH_USERS} WHERE s.id = ?1 AND s.deleted_at IS NULL`
  )
    .bind(id)
    .first<SkillWithUsersRow>()
  return row ?? null
}

export async function getSkillBySlug(env: Env, slug: string): Promise<SkillWithUsersRow | null> {
  const row = await env.DB.prepare(
    `${SELECT_SKILL_WITH_USERS} WHERE s.slug = ?1 AND s.deleted_at IS NULL`
  )
    .bind(slug)
    .first<SkillWithUsersRow>()
  return row ?? null
}

export interface CreateSkillInput {
  slug?: string
  title: string
  description: string
  triggerText?: string
  status?: 'draft' | 'published' | 'archived'
  drafterMeta?: unknown
  createdBy: string
}

/**
 * Create a new skill. Slug collision retry mirrors createDoc — slugify
 * the title if no slug supplied, append a random suffix on UNIQUE
 * violation (up to 3 retries). Status defaults to 'draft'.
 *
 * `drafterMeta` is an opaque JSON value persisted alongside the row;
 * used by the CLI `draft-skill` command to record model + version +
 * context inputs. Null/undefined for manually-authored skills.
 */
export async function createSkill(env: Env, input: CreateSkillInput): Promise<SkillRow> {
  const id = newId()
  const now = Math.floor(Date.now() / 1000)
  const baseSlug = input.slug ?? suggestSlug('skill', input.title)
  const status = input.status ?? 'draft'
  const triggerText = input.triggerText ?? ''
  const drafterMetaJson =
    input.drafterMeta !== undefined && input.drafterMeta !== null
      ? JSON.stringify(input.drafterMeta)
      : null

  for (let attempt = 0; attempt < 4; attempt++) {
    const slug = attempt === 0 ? baseSlug : `${baseSlug}-${randomSuffix()}`
    try {
      await env.DB.prepare(
        `INSERT INTO skills
           (id, slug, title, description, trigger_text, status, drafter_meta,
            created_by, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`
      )
        .bind(
          id,
          slug,
          input.title,
          input.description,
          triggerText,
          status,
          drafterMetaJson,
          input.createdBy,
          now
        )
        .run()
      const row = await env.DB.prepare(
        `SELECT id, slug, title, description, trigger_text, status,
                current_rev_id, r2_snapshot, drafter_meta, created_by,
                created_at, updated_at, deleted_at
         FROM skills WHERE id = ?1`
      )
        .bind(id)
        .first<SkillRow>()
      if (!row) throw new Error('skill_insert_lost')
      return row
    } catch (err) {
      if (isUniqueViolation(err) && attempt < 3) continue
      throw err
    }
  }
  throw new Error('skill_slug_collision_persistent')
}

export interface PatchSkillInput {
  // slug intentionally omitted: skill slugs are immutable after creation
  // (public MCP id + on-disk SKILL.md path).
  title?: string
  description?: string
  triggerText?: string
  status?: 'draft' | 'published' | 'archived'
}

export async function patchSkill(env: Env, id: string, patch: PatchSkillInput): Promise<void> {
  const fields: string[] = []
  const binds: unknown[] = []
  if (patch.title !== undefined) {
    fields.push(`title = ?${fields.length + 1}`)
    binds.push(patch.title)
  }
  if (patch.description !== undefined) {
    fields.push(`description = ?${fields.length + 1}`)
    binds.push(patch.description)
  }
  if (patch.triggerText !== undefined) {
    fields.push(`trigger_text = ?${fields.length + 1}`)
    binds.push(patch.triggerText)
  }
  if (patch.status !== undefined) {
    fields.push(`status = ?${fields.length + 1}`)
    binds.push(patch.status)
  }
  if (fields.length === 0) return
  fields.push(`updated_at = ?${fields.length + 1}`)
  binds.push(Math.floor(Date.now() / 1000))
  binds.push(id)
  await env.DB.prepare(
    `UPDATE skills SET ${fields.join(', ')}
     WHERE id = ?${binds.length} AND deleted_at IS NULL`
  )
    .bind(...binds)
    .run()
}

export async function softDeleteSkill(env: Env, id: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  await env.DB.prepare(`UPDATE skills SET deleted_at = ?1 WHERE id = ?2`).bind(now, id).run()
}

export interface RecordSkillRevisionInput {
  skillId: string
  revisionId: string
  authorId: string
  r2Key: string
  byteSize: number
  contentHash: string
  // Defaults to 'explicit'. See db/revision-policy.ts.
  kind?: RevisionKind
}

/**
 * Insert a revision row and bump parent skill's current_rev_id +
 * r2_snapshot + updated_at. Two statements; same pattern as
 * recordRevision in docs.ts.
 */
export async function recordSkillRevision(
  env: Env,
  input: RecordSkillRevisionInput
): Promise<SkillRevisionRow> {
  const now = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO skill_revisions
       (id, skill_id, author_id, r2_key, byte_size, content_hash, created_at, kind)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
  )
    .bind(
      input.revisionId,
      input.skillId,
      input.authorId,
      input.r2Key,
      input.byteSize,
      input.contentHash,
      now,
      input.kind ?? 'explicit'
    )
    .run()
  await env.DB.prepare(
    `UPDATE skills SET current_rev_id = ?1, r2_snapshot = ?2, updated_at = ?3 WHERE id = ?4`
  )
    .bind(input.revisionId, input.r2Key, now, input.skillId)
    .run()
  const row = await env.DB.prepare(
    `SELECT id, skill_id, author_id, r2_key, byte_size, content_hash, created_at, kind
     FROM skill_revisions WHERE id = ?1`
  )
    .bind(input.revisionId)
    .first<SkillRevisionRow>()
  if (!row) throw new Error('skill_revision_insert_lost')
  return row
}

/** Skill's current head revision, or null. Mirrors getHeadRevision. */
export async function getHeadSkillRevision(
  env: Env,
  skillId: string
): Promise<HeadRevision | null> {
  const row = await env.DB.prepare(
    `SELECT r.id, r.author_id, r.content_hash, r.created_at, r.kind
     FROM skills s
     JOIN skill_revisions r ON r.id = s.current_rev_id
     WHERE s.id = ?1 AND s.deleted_at IS NULL`
  )
    .bind(skillId)
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

/** Overwrite the rolling autosave head in place. Mirrors amendRevision. */
export async function amendSkillRevision(
  env: Env,
  input: { skillId: string; revisionId: string; byteSize: number; contentHash: string }
): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `UPDATE skill_revisions SET byte_size = ?1, content_hash = ?2 WHERE id = ?3`
  )
    .bind(input.byteSize, input.contentHash, input.revisionId)
    .run()
  await env.DB.prepare(`UPDATE skills SET updated_at = ?1 WHERE id = ?2`)
    .bind(now, input.skillId)
    .run()
}

/** Promote a head autosave revision to 'explicit'. Mirrors sealRevision. */
export async function sealSkillRevision(
  env: Env,
  skillId: string,
  revisionId: string
): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  await env.DB.prepare(`UPDATE skill_revisions SET kind = 'explicit' WHERE id = ?1`)
    .bind(revisionId)
    .run()
  await env.DB.prepare(`UPDATE skills SET updated_at = ?1 WHERE id = ?2`)
    .bind(now, skillId)
    .run()
}

/** Retention prune for skill autosaves. Mirrors pruneAutosaveRevisions. */
export async function pruneAutosaveSkillRevisions(
  env: Env,
  skillId: string,
  keep: number
): Promise<string[]> {
  const headRow = await env.DB.prepare(`SELECT current_rev_id FROM skills WHERE id = ?1`)
    .bind(skillId)
    .first<{ current_rev_id: string | null }>()
  const headId = headRow?.current_rev_id ?? ''
  const victims = await env.DB.prepare(
    `SELECT id, r2_key FROM skill_revisions
     WHERE skill_id = ?1 AND kind = 'autosave' AND id != ?2
       AND id NOT IN (
         SELECT id FROM skill_revisions
         WHERE skill_id = ?1 AND kind = 'autosave'
         ORDER BY created_at DESC, id DESC
         LIMIT ?3
       )`
  )
    .bind(skillId, headId, keep)
    .all<{ id: string; r2_key: string }>()
  const rows = victims.results ?? []
  if (rows.length === 0) return []
  const ids = rows.map((r) => r.id)
  const placeholders = ids.map((_, i) => `?${i + 1}`).join(', ')
  await env.DB.prepare(`DELETE FROM skill_revisions WHERE id IN (${placeholders})`)
    .bind(...ids)
    .run()
  return rows.map((r) => r.r2_key)
}

export async function listSkillRevisions(env: Env, skillId: string): Promise<SkillRevisionRow[]> {
  const res = await env.DB.prepare(
    `SELECT id, skill_id, author_id, r2_key, byte_size, content_hash, created_at, kind
     FROM skill_revisions WHERE skill_id = ?1 ORDER BY created_at DESC LIMIT 100`
  )
    .bind(skillId)
    .all<SkillRevisionRow>()
  return res.results ?? []
}

export async function getSkillRevision(
  env: Env,
  skillId: string,
  revisionId: string
): Promise<SkillRevisionRow | null> {
  const row = await env.DB.prepare(
    `SELECT id, skill_id, author_id, r2_key, byte_size, content_hash, created_at, kind
     FROM skill_revisions WHERE skill_id = ?1 AND id = ?2`
  )
    .bind(skillId, revisionId)
    .first<SkillRevisionRow>()
  return row ?? null
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

function isUniqueViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /UNIQUE constraint failed/i.test(msg)
}
