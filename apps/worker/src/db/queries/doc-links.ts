/**
 * D1 queries for `doc_links` — the resolved inter-doc link graph (migration
 * 0027). Rebuilt from a doc's markdown on every reindex; powers incoming-
 * reference lookups, dangling-link surfacing, and move/rename rewrites.
 */

import type { Env } from '../../env'

export interface DocLinkRow {
  source_doc_id: string
  target_doc_id: string | null
  target_ref: string
}

/** Resolve a set of slugs to doc ids in one round trip (non-deleted only). */
export async function getDocIdsBySlugs(
  env: Env,
  slugs: string[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const uniq = [...new Set(slugs)]
  if (uniq.length === 0) return out
  const placeholders = uniq.map((_, i) => `?${i + 1}`).join(', ')
  const res = await env.DB.prepare(
    `SELECT id, slug FROM documents WHERE slug IN (${placeholders}) AND deleted_at IS NULL`
  )
    .bind(...uniq)
    .all<{ id: string; slug: string }>()
  for (const r of res.results ?? []) out.set(r.slug, r.id)
  return out
}

/** Of the supplied ids, which exist (non-deleted). For legacy `/app/docs/{id}`. */
export async function existingDocIds(env: Env, ids: string[]): Promise<Set<string>> {
  const uniq = [...new Set(ids)]
  if (uniq.length === 0) return new Set()
  const placeholders = uniq.map((_, i) => `?${i + 1}`).join(', ')
  const res = await env.DB.prepare(
    `SELECT id FROM documents WHERE id IN (${placeholders}) AND deleted_at IS NULL`
  )
    .bind(...uniq)
    .all<{ id: string }>()
  return new Set((res.results ?? []).map((r) => r.id))
}

/**
 * Replace all outgoing links for a source doc with the supplied set (one D1
 * batch: delete + per-link insert). `targetDocId` null = a dangling link
 * (tolerated per OKF §9, surfaced not rejected). De-duped by target_ref to
 * satisfy the PK.
 */
export async function replaceDocLinks(
  env: Env,
  sourceDocId: string,
  links: Array<{ targetRef: string; targetDocId: string | null }>
): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  const seen = new Set<string>()
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(`DELETE FROM doc_links WHERE source_doc_id = ?1`).bind(sourceDocId)
  ]
  for (const link of links) {
    if (seen.has(link.targetRef)) continue
    seen.add(link.targetRef)
    stmts.push(
      env.DB.prepare(
        `INSERT INTO doc_links (source_doc_id, target_doc_id, target_ref, created_at)
         VALUES (?1, ?2, ?3, ?4)`
      ).bind(sourceDocId, link.targetDocId, link.targetRef, now)
    )
  }
  await env.DB.batch(stmts)
}

/** Source docs that link TO `docId` (incoming refs + move-rewrite driver). */
export async function getIncomingLinks(env: Env, docId: string): Promise<DocLinkRow[]> {
  const res = await env.DB.prepare(
    `SELECT source_doc_id, target_doc_id, target_ref FROM doc_links WHERE target_doc_id = ?1`
  )
    .bind(docId)
    .all<DocLinkRow>()
  return res.results ?? []
}

/** Outgoing links FROM `docId` (resolved + dangling) for the editor panel. */
export async function getOutgoingLinks(env: Env, docId: string): Promise<DocLinkRow[]> {
  const res = await env.DB.prepare(
    `SELECT source_doc_id, target_doc_id, target_ref FROM doc_links WHERE source_doc_id = ?1`
  )
    .bind(docId)
    .all<DocLinkRow>()
  return res.results ?? []
}
