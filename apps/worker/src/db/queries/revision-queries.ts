/**
 * D1 twin of `storage/revision-store.ts`'s `makeRevisionStore`: the
 * revision machinery (record / head / amend / seal / prune / list / get)
 * parameterised on the parent + revision table pair. `docs.ts` and
 * `skills.ts` instantiate it and re-export the members under their
 * historical names, so the two sides cannot drift (C4 in the 2026-08
 * review). `doc_revisions` and `skill_revisions` are schema-identical by
 * design — 0011 mirrors 0002, and 0017 added `kind` to both.
 */

import type { Env } from '../../env'
import type { HeadRevision, RevisionKind } from '../revision-policy'

export interface RecordRevisionInputBase {
  parentId: string
  revisionId: string
  authorId: string
  r2Key: string
  byteSize: number
  contentHash: string
  // Defaults to 'explicit'. Autosaves pass 'autosave' so the next one can
  // coalesce into this row (see db/revision-policy.ts).
  kind?: RevisionKind
}

export interface RevisionTableConfig {
  /** Parent table holding `current_rev_id` / `r2_snapshot` / `updated_at`. */
  parentTable: string
  /** The revision table itself. */
  revisionTable: string
  /** FK column on the revision table pointing at the parent. */
  fkColumn: string
  /** Error thrown when the freshly inserted row can't be read back. */
  insertLostError: string
}

export function makeRevisionQueries<Row>(cfg: RevisionTableConfig) {
  const SELECT_REVISION = `SELECT id, ${cfg.fkColumn}, author_id, r2_key, byte_size, content_hash, created_at, kind
     FROM ${cfg.revisionTable}`

  return {
    /**
     * Insert a new revision row and bump the parent's current_rev_id +
     * r2_snapshot + updated_at. Atomic: the revision INSERT and the
     * head/snapshot UPDATE land together as one D1 transaction, so a
     * crash can't leave a revision row without a head pointer (or a head
     * pointing at a revision that never inserted).
     */
    async record(env: Env, input: RecordRevisionInputBase): Promise<Row> {
      const now = Math.floor(Date.now() / 1000)
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO ${cfg.revisionTable}
             (id, ${cfg.fkColumn}, author_id, r2_key, byte_size, content_hash, created_at, kind)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
        ).bind(
          input.revisionId,
          input.parentId,
          input.authorId,
          input.r2Key,
          input.byteSize,
          input.contentHash,
          now,
          input.kind ?? 'explicit'
        ),
        env.DB.prepare(
          `UPDATE ${cfg.parentTable} SET current_rev_id = ?1, r2_snapshot = ?2, updated_at = ?3 WHERE id = ?4`
        ).bind(input.revisionId, input.r2Key, now, input.parentId)
      ])
      const row = await env.DB.prepare(`${SELECT_REVISION} WHERE id = ?1`)
        .bind(input.revisionId)
        .first<Row>()
      if (!row) throw new Error(cfg.insertLostError)
      return row
    },

    /**
     * The parent's current head revision (its `current_rev_id` row), or
     * null if it has none yet. Backs the autosave-coalescing decision:
     * the policy folds an autosave into this row when it's an open,
     * same-author, in-window autosave. Returns only the fields the
     * policy needs.
     */
    async head(env: Env, parentId: string): Promise<HeadRevision | null> {
      const row = await env.DB.prepare(
        `SELECT r.id, r.author_id, r.content_hash, r.created_at, r.kind
         FROM ${cfg.parentTable} p
         JOIN ${cfg.revisionTable} r ON r.id = p.current_rev_id
         WHERE p.id = ?1 AND p.deleted_at IS NULL`
      )
        .bind(parentId)
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
    },

    /**
     * Overwrite the rolling autosave head in place: refresh its byte_size +
     * content_hash (the R2 object was already overwritten at the same
     * revision id) and bump the parent's updated_at. created_at stays put —
     * it's the coalesce-window anchor, so the row ages out after the window
     * even under continuous typing. current_rev_id / r2_snapshot are
     * unchanged (same revision id).
     */
    async amend(
      env: Env,
      input: { parentId: string; revisionId: string; byteSize: number; contentHash: string }
    ): Promise<void> {
      const now = Math.floor(Date.now() / 1000)
      await env.DB.prepare(
        `UPDATE ${cfg.revisionTable} SET byte_size = ?1, content_hash = ?2 WHERE id = ?3`
      )
        .bind(input.byteSize, input.contentHash, input.revisionId)
        .run()
      await env.DB.prepare(`UPDATE ${cfg.parentTable} SET updated_at = ?1 WHERE id = ?2`)
        .bind(now, input.parentId)
        .run()
    },

    /**
     * Promote a head autosave revision to 'explicit' — the user clicked
     * Save on content identical to the rolling autosave. Freezes it as a
     * checkpoint so the next autosave cuts a new row instead of
     * overwriting this one.
     */
    async seal(env: Env, parentId: string, revisionId: string): Promise<void> {
      const now = Math.floor(Date.now() / 1000)
      await env.DB.prepare(`UPDATE ${cfg.revisionTable} SET kind = 'explicit' WHERE id = ?1`)
        .bind(revisionId)
        .run()
      await env.DB.prepare(`UPDATE ${cfg.parentTable} SET updated_at = ?1 WHERE id = ?2`)
        .bind(now, parentId)
        .run()
    },

    /**
     * Retention prune: delete all but the `keep` most-recent autosave
     * revisions, returning the R2 keys of the deleted rows so the caller
     * can drop their bodies. Explicit revisions are never touched, and
     * the parent's current head is always spared (it may be the rolling
     * autosave holding live content). Two statements (select victims →
     * delete by id) so the freed R2 keys come back without relying on
     * DELETE … RETURNING.
     */
    async pruneAutosaves(env: Env, parentId: string, keep: number): Promise<string[]> {
      const headRow = await env.DB.prepare(
        `SELECT current_rev_id FROM ${cfg.parentTable} WHERE id = ?1`
      )
        .bind(parentId)
        .first<{ current_rev_id: string | null }>()
      const headId = headRow?.current_rev_id ?? ''
      const victims = await env.DB.prepare(
        `SELECT id, r2_key FROM ${cfg.revisionTable}
         WHERE ${cfg.fkColumn} = ?1 AND kind = 'autosave' AND id != ?2
           AND id NOT IN (
             SELECT id FROM ${cfg.revisionTable}
             WHERE ${cfg.fkColumn} = ?1 AND kind = 'autosave'
             ORDER BY created_at DESC, id DESC
             LIMIT ?3
           )`
      )
        .bind(parentId, headId, keep)
        .all<{ id: string; r2_key: string }>()
      const rows = victims.results ?? []
      if (rows.length === 0) return []
      const ids = rows.map((r) => r.id)
      const placeholders = ids.map((_, i) => `?${i + 1}`).join(', ')
      await env.DB.prepare(`DELETE FROM ${cfg.revisionTable} WHERE id IN (${placeholders})`)
        .bind(...ids)
        .run()
      return rows.map((r) => r.r2_key)
    },

    async list(env: Env, parentId: string): Promise<Row[]> {
      const res = await env.DB.prepare(
        `${SELECT_REVISION} WHERE ${cfg.fkColumn} = ?1 ORDER BY created_at DESC LIMIT 100`
      )
        .bind(parentId)
        .all<Row>()
      return res.results ?? []
    },

    async get(env: Env, parentId: string, revisionId: string): Promise<Row | null> {
      const row = await env.DB.prepare(
        `${SELECT_REVISION} WHERE ${cfg.fkColumn} = ?1 AND id = ?2`
      )
        .bind(parentId, revisionId)
        .first<Row>()
      return row ?? null
    }
  }
}
