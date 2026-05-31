/**
 * R2 layout for doc bodies. Two object kinds per doc:
 *
 *   docs/{docId}/snapshot.json            -- always reflects current_rev
 *   docs/{docId}/revisions/{revId}.json   -- immutable per-save copies
 *
 * Snapshot is a convenience: the MCP `get_doc` tool (M2c) and SPA
 * editor load fetch the snapshot in one round-trip without first
 * reading `documents.current_rev_id` from D1. Snapshot and the latest
 * revision row are equal by content_hash; if they ever diverge (e.g.
 * crashed mid-write), the revision row wins on the next read.
 *
 * Bodies are BlockNote JSON (see PLAN.md M2a decision). Stored as
 * application/json with a sha256 content hash returned to the caller
 * so the route handler can persist it on the doc_revisions row.
 */

import type { Env } from '../env'
import type { DocContent } from '@ctxlayer/shared'

export const CONTENT_TYPE = 'application/json; charset=utf-8'
export const YJS_CONTENT_TYPE = 'application/octet-stream'
export const MARKDOWN_CONTENT_TYPE = 'text/markdown; charset=utf-8'

export function snapshotKey(docId: string): string {
  return `docs/${docId}/snapshot.json`
}

/**
 * Canonical raw markdown for git-synced docs. Source of truth for these
 * docs (the BlockNote blocks snapshot is derived, materialised lazily in
 * the browser on first open). The reindex consumer chunks this directly
 * for RAG, skipping the lossy blocks→markdown render.
 */
export function sourceMarkdownKey(docId: string): string {
  return `docs/${docId}/source.md`
}

export async function writeSourceMarkdown(
  env: Env,
  docId: string,
  markdown: string
): Promise<{ contentHash: string; byteSize: number }> {
  const body = new TextEncoder().encode(markdown)
  const contentHash = await sha256Hex(body)
  await env.DOCS_BUCKET.put(sourceMarkdownKey(docId), body, {
    httpMetadata: { contentType: MARKDOWN_CONTENT_TYPE },
    customMetadata: { contentHash }
  })
  return { contentHash, byteSize: body.byteLength }
}

export async function readSourceMarkdown(env: Env, docId: string): Promise<string | null> {
  const obj = await env.DOCS_BUCKET.get(sourceMarkdownKey(docId))
  if (!obj) return null
  return obj.text()
}

export function revisionKey(docId: string, revisionId: string): string {
  return `docs/${docId}/revisions/${revisionId}.json`
}

export function yjsSnapshotKey(docId: string): string {
  return `docs/${docId}/yjs/snapshot.bin`
}

export interface PutResult {
  key: string
  byteSize: number
  contentHash: string
}

/**
 * Persist a revision and refresh the snapshot in a single call. R2 has
 * no transactions; we write the revision first so a partial failure
 * leaves the previous snapshot intact rather than orphaning it.
 */
export async function writeRevisionAndSnapshot(
  env: Env,
  docId: string,
  revisionId: string,
  content: DocContent
): Promise<PutResult> {
  const body = serialize(content)
  const contentHash = await sha256Hex(body)
  const byteSize = body.byteLength

  await env.DOCS_BUCKET.put(revisionKey(docId, revisionId), body, {
    httpMetadata: { contentType: CONTENT_TYPE },
    customMetadata: { contentHash, revisionId }
  })
  await env.DOCS_BUCKET.put(snapshotKey(docId), body, {
    httpMetadata: { contentType: CONTENT_TYPE },
    customMetadata: { contentHash, revisionId }
  })

  return { key: revisionKey(docId, revisionId), byteSize, contentHash }
}

/** Load the current snapshot. Returns null if R2 has no object yet. */
export async function readSnapshot(env: Env, docId: string): Promise<DocContent | null> {
  const obj = await env.DOCS_BUCKET.get(snapshotKey(docId))
  if (!obj) return null
  return parse(await obj.arrayBuffer())
}

/** Content hash of the current snapshot (from R2 metadata), or null. */
export async function readSnapshotHash(env: Env, docId: string): Promise<string | null> {
  const head = await env.DOCS_BUCKET.head(snapshotKey(docId))
  return head?.customMetadata?.contentHash ?? null
}

/** Stable content hash for a DocContent body. */
export async function hashContent(content: DocContent): Promise<string> {
  return sha256Hex(serialize(content))
}

/**
 * Write ONLY the materialised snapshot (no new revision). Used by the
 * collab DO to reconcile `snapshot.json` from the authoritative Y.Doc so
 * MCP `get_doc` / `GET /content` reflect collab edits even when the
 * client REST autosave never fired (e.g. a locked, never-REST-saved
 * doc). Revisions stay owned by the explicit save path; this only keeps
 * the read snapshot truthful.
 */
export async function writeMaterializedSnapshot(
  env: Env,
  docId: string,
  content: DocContent
): Promise<string> {
  const body = serialize(content)
  const contentHash = await sha256Hex(body)
  await env.DOCS_BUCKET.put(snapshotKey(docId), body, {
    httpMetadata: { contentType: CONTENT_TYPE },
    customMetadata: { contentHash }
  })
  return contentHash
}

/** Load a specific revision. Returns null if missing (e.g. R2 pruned). */
export async function readRevision(
  env: Env,
  docId: string,
  revisionId: string
): Promise<DocContent | null> {
  const obj = await env.DOCS_BUCKET.get(revisionKey(docId, revisionId))
  if (!obj) return null
  return parse(await obj.arrayBuffer())
}

/**
 * Yjs binary snapshot helpers. These persist `Y.encodeStateAsUpdate(doc)`
 * bytes so a `DocRoomDO` cold-wake can rebuild the live collab state
 * without round-tripping through BlockNote JSON. There's only ever one
 * current Y.Doc snapshot per doc — the human-facing revision history
 * stays in the JSON layout above.
 */
export async function readYjsSnapshot(env: Env, docId: string): Promise<Uint8Array | null> {
  const obj = await env.DOCS_BUCKET.get(yjsSnapshotKey(docId))
  if (!obj) return null
  return new Uint8Array(await obj.arrayBuffer())
}

export async function writeYjsSnapshot(
  env: Env,
  docId: string,
  bytes: Uint8Array
): Promise<void> {
  await env.DOCS_BUCKET.put(yjsSnapshotKey(docId), bytes, {
    httpMetadata: { contentType: YJS_CONTENT_TYPE }
  })
}

/**
 * Restore a previous revision: copy its bytes to a fresh revision id
 * and refresh the snapshot. Equivalent to "save the old content as a
 * new revision" so the timeline stays append-only.
 */
export async function restoreFromRevision(
  env: Env,
  docId: string,
  fromRevisionId: string,
  newRevisionId: string
): Promise<PutResult | null> {
  const content = await readRevision(env, docId, fromRevisionId)
  if (!content) return null
  return writeRevisionAndSnapshot(env, docId, newRevisionId, content)
}

// ----- helpers -----------------------------------------------------------

function serialize(content: DocContent): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(content))
}

function parse(buf: ArrayBuffer): DocContent {
  const text = new TextDecoder().decode(buf)
  return JSON.parse(text) as DocContent
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const view = new Uint8Array(digest)
  let hex = ''
  for (const b of view) hex += b.toString(16).padStart(2, '0')
  return hex
}
