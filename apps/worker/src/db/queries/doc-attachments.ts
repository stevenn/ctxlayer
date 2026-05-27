/**
 * D1 queries for doc ↔ upstream(.tool) attachments. Symmetric with
 * skill-attachments.ts. Reference docs ("Datadog naming conventions")
 * surface alongside procedural skills on the upstream's MCP listing.
 */

import type { Env } from '../../env'

export interface DocAttachmentRow {
  doc_id: string
  upstream_id: string
  upstream_slug: string
  tool_name: string
}

export async function listAttachmentsForDoc(
  env: Env,
  docId: string
): Promise<DocAttachmentRow[]> {
  const res = await env.DB.prepare(
    `SELECT da.doc_id, da.upstream_id, da.tool_name,
            u.slug AS upstream_slug
     FROM doc_attachments da
     JOIN upstream_servers u ON u.id = da.upstream_id
     WHERE da.doc_id = ?1
     ORDER BY u.slug, da.tool_name`
  )
    .bind(docId)
    .all<DocAttachmentRow>()
  return res.results ?? []
}

export interface DocForUpstreamRow {
  doc_id: string
  slug: string
  title: string
  tool_name: string
}

export async function listDocsForUpstream(
  env: Env,
  upstreamId: string
): Promise<DocForUpstreamRow[]> {
  const res = await env.DB.prepare(
    `SELECT da.doc_id, d.slug, d.title, da.tool_name
     FROM doc_attachments da
     JOIN documents d ON d.id = da.doc_id
     WHERE da.upstream_id = ?1 AND d.deleted_at IS NULL
     ORDER BY da.tool_name, d.title`
  )
    .bind(upstreamId)
    .all<DocForUpstreamRow>()
  return res.results ?? []
}

export interface AttachDocInput {
  docId: string
  upstreamId: string
  toolName?: string
  createdBy: string
}

export async function attachDoc(env: Env, input: AttachDocInput): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT OR IGNORE INTO doc_attachments
       (doc_id, upstream_id, tool_name, created_at, created_by)
     VALUES (?1, ?2, ?3, ?4, ?5)`
  )
    .bind(input.docId, input.upstreamId, input.toolName ?? '', now, input.createdBy)
    .run()
}

export async function detachDoc(
  env: Env,
  input: { docId: string; upstreamId: string; toolName?: string }
): Promise<void> {
  await env.DB.prepare(
    `DELETE FROM doc_attachments
     WHERE doc_id = ?1 AND upstream_id = ?2 AND tool_name = ?3`
  )
    .bind(input.docId, input.upstreamId, input.toolName ?? '')
    .run()
}
