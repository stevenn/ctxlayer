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

export function snapshotKey(docId: string): string {
  return `docs/${docId}/snapshot.json`
}

export function revisionKey(docId: string, revisionId: string): string {
  return `docs/${docId}/revisions/${revisionId}.json`
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
