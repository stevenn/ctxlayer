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
 * Bodies are BlockNote JSON (see PLAN.md M2a decision). The shared
 * snapshot/revision machinery lives in revision-store.ts; this module
 * instantiates it under the `docs/` prefix and adds the doc-only
 * extras (source markdown for git-synced docs, Yjs binary snapshots).
 */

import type { Env } from '../env'
import { sha256Hex } from '../crypto/hash'
import { makeRevisionStore } from './revision-store'

export type { PutResult } from './revision-store'

const YJS_CONTENT_TYPE = 'application/octet-stream'
const MARKDOWN_CONTENT_TYPE = 'text/markdown; charset=utf-8'

const store = makeRevisionStore('docs')

export const writeRevisionAndSnapshot = store.writeRevisionAndSnapshot
export const readSnapshot = store.readSnapshot
export const readSnapshotHash = store.readSnapshotHash
export const hashContent = store.hashContent
export const contentDigest = store.contentDigest
export const writeMaterializedSnapshot = store.writeMaterializedSnapshot
export const deleteRevisionObjects = store.deleteRevisionObjects
export const readRevision = store.readRevision
export const restoreFromRevision = store.restoreFromRevision

/**
 * Canonical raw markdown for git-synced docs. Source of truth for these
 * docs (the BlockNote blocks snapshot is derived, materialised lazily in
 * the browser on first open). The reindex consumer chunks this directly
 * for RAG, skipping the lossy blocks→markdown render.
 */
function sourceMarkdownKey(docId: string): string {
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

function yjsSnapshotKey(docId: string): string {
  return `docs/${docId}/yjs/snapshot.bin`
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

export async function writeYjsSnapshot(env: Env, docId: string, bytes: Uint8Array): Promise<void> {
  await env.DOCS_BUCKET.put(yjsSnapshotKey(docId), bytes, {
    httpMetadata: { contentType: YJS_CONTENT_TYPE }
  })
}
