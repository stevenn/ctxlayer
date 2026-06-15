/**
 * D1 queries for `doc_tags` and the user-scope resolver used by both
 * the reindex consumer (chunk metadata) and `search_docs` (filter
 * predicate). Per PLAN.md F1, tag_value stores team_id / product_id
 * for the 'team' / 'product' kinds; free-form 'tag' kind carries slugs.
 */

import type { Env } from '../../env'
import type { DocTags } from '@ctxlayer/shared'

export type TagKind = 'team' | 'product' | 'tag'

interface TagRow {
  tag_kind: TagKind
  tag_value: string
}

/** Read all tags for a doc, grouped by kind. */
export async function listTagsForDoc(env: Env, docId: string): Promise<DocTags> {
  const res = await env.DB.prepare(`SELECT tag_kind, tag_value FROM doc_tags WHERE doc_id = ?1`)
    .bind(docId)
    .all<TagRow>()
  const out: DocTags = { teams: [], products: [], tags: [] }
  for (const row of res.results ?? []) {
    if (row.tag_kind === 'team') out.teams.push(row.tag_value)
    else if (row.tag_kind === 'product') out.products.push(row.tag_value)
    else if (row.tag_kind === 'tag') out.tags.push(row.tag_value)
  }
  return out
}

/**
 * Replace all tags for a doc with the supplied set. Single D1 batch
 * (delete + per-tag insert) so the table is never partially updated.
 * Caller has already validated ids (canEdit + existence checks live
 * in the route layer).
 */
export async function replaceTagsForDoc(env: Env, docId: string, tags: DocTags): Promise<void> {
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(`DELETE FROM doc_tags WHERE doc_id = ?1`).bind(docId)
  ]
  for (const teamId of tags.teams) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO doc_tags (doc_id, tag_kind, tag_value) VALUES (?1, 'team', ?2)`
      ).bind(docId, teamId)
    )
  }
  for (const productId of tags.products) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO doc_tags (doc_id, tag_kind, tag_value) VALUES (?1, 'product', ?2)`
      ).bind(docId, productId)
    )
  }
  for (const tag of tags.tags) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO doc_tags (doc_id, tag_kind, tag_value) VALUES (?1, 'tag', ?2)`
      ).bind(docId, tag)
    )
  }
  await env.DB.batch(stmts)
}

/**
 * Set the sole product tag on a doc (used by git sync: a synced doc's
 * product is owned by its source). Replaces only `product`-kind tags —
 * team / free-form tags the user added are left intact. `productId === null`
 * just clears product tags. Single batch.
 */
export async function setDocProductTag(
  env: Env,
  docId: string,
  productId: string | null
): Promise<void> {
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(`DELETE FROM doc_tags WHERE doc_id = ?1 AND tag_kind = 'product'`).bind(docId)
  ]
  if (productId) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO doc_tags (doc_id, tag_kind, tag_value) VALUES (?1, 'product', ?2)
         ON CONFLICT (doc_id, tag_kind, tag_value) DO NOTHING`
      ).bind(docId, productId)
    )
  }
  await env.DB.batch(stmts)
}

/**
 * Add free-form tags to a doc without disturbing its team/product/existing
 * tags. Used by OKF import (git sync + import modal): frontmatter `tags` map
 * to these VERBATIM (trim + collapse whitespace + length cap only — no
 * slugging, so `BigQuery Table` round-trips intact). Additive + idempotent
 * (ON CONFLICT DO NOTHING) — a re-sync never removes a tag, matching the
 * "tags organise, never gate" stance.
 */
export async function addDocTags(env: Env, docId: string, tags: string[]): Promise<void> {
  const seen = new Set<string>()
  const normalised: string[] = []
  for (const raw of tags) {
    const value = raw.trim().replace(/\s+/g, ' ').slice(0, 96)
    const key = value.toLowerCase()
    if (!value || seen.has(key)) continue
    seen.add(key)
    normalised.push(value)
  }
  if (normalised.length === 0) return
  const stmts = normalised.map((tag) =>
    env.DB.prepare(
      `INSERT INTO doc_tags (doc_id, tag_kind, tag_value) VALUES (?1, 'tag', ?2)
       ON CONFLICT (doc_id, tag_kind, tag_value) DO NOTHING`
    ).bind(docId, tag)
  )
  await env.DB.batch(stmts)
}

/**
 * Resolve the (team_ids, product_ids) a user has access to. Powers
 * the `search_docs` Vectorize filter (Section F3) and `list_my_context`.
 * Product access is transitive via team_products.
 */
export async function resolveUserScope(
  env: Env,
  userId: string
): Promise<{ teams: string[]; products: string[] }> {
  const [teamsRes, productsRes] = await Promise.all([
    env.DB.prepare(`SELECT team_id FROM team_members WHERE user_id = ?1`)
      .bind(userId)
      .all<{ team_id: string }>(),
    env.DB.prepare(
      `SELECT DISTINCT tp.product_id AS product_id
       FROM team_products tp
       JOIN team_members tm ON tm.team_id = tp.team_id
       WHERE tm.user_id = ?1`
    )
      .bind(userId)
      .all<{ product_id: string }>()
  ])
  return {
    teams: (teamsRes.results ?? []).map((r) => r.team_id),
    products: (productsRes.results ?? []).map((r) => r.product_id)
  }
}
