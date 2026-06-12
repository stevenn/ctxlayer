/**
 * Shared R2 revision-store machinery for docs and skills. Both use the
 * same layout under a different key prefix:
 *
 *   {prefix}/{id}/snapshot.json            -- always reflects current_rev
 *   {prefix}/{id}/revisions/{revId}.json   -- immutable per-save copies
 *
 * Bodies are BlockNote JSON (DocContent). Stored as application/json
 * with a sha256 content hash returned to the caller so the route
 * handler can persist it on the revision row. docs-r2.ts / skills-r2.ts
 * instantiate this and keep their entity-specific extras.
 */

import type { Env } from '../env'
import type { DocContent } from '@ctxlayer/shared'
import { sha256Hex } from '../crypto/hash'

const CONTENT_TYPE = 'application/json; charset=utf-8'

export interface PutResult {
  key: string
  byteSize: number
  contentHash: string
}

export function makeRevisionStore(prefix: string) {
  const snapshotKey = (id: string): string => `${prefix}/${id}/snapshot.json`
  const revisionKey = (id: string, revisionId: string): string =>
    `${prefix}/${id}/revisions/${revisionId}.json`

  /**
   * Persist a revision and refresh the snapshot in a single call. R2 has
   * no transactions; we write the revision first so a partial failure
   * leaves the previous snapshot intact rather than orphaning it.
   */
  async function writeRevisionAndSnapshot(
    env: Env,
    id: string,
    revisionId: string,
    content: DocContent
  ): Promise<PutResult> {
    const body = serialize(content)
    const contentHash = await sha256Hex(body)
    const byteSize = body.byteLength

    await env.DOCS_BUCKET.put(revisionKey(id, revisionId), body, {
      httpMetadata: { contentType: CONTENT_TYPE },
      customMetadata: { contentHash, revisionId }
    })
    await env.DOCS_BUCKET.put(snapshotKey(id), body, {
      httpMetadata: { contentType: CONTENT_TYPE },
      customMetadata: { contentHash, revisionId }
    })

    return { key: revisionKey(id, revisionId), byteSize, contentHash }
  }

  /** Load the current snapshot. Returns null if R2 has no object yet. */
  async function readSnapshot(env: Env, id: string): Promise<DocContent | null> {
    const obj = await env.DOCS_BUCKET.get(snapshotKey(id))
    if (!obj) return null
    return parse(await obj.arrayBuffer())
  }

  /** Content hash of the current snapshot (from R2 metadata), or null. */
  async function readSnapshotHash(env: Env, id: string): Promise<string | null> {
    const head = await env.DOCS_BUCKET.head(snapshotKey(id))
    return head?.customMetadata?.contentHash ?? null
  }

  /** Stable content hash for a DocContent body. */
  async function hashContent(content: DocContent): Promise<string> {
    return sha256Hex(serialize(content))
  }

  /**
   * Hash + byte size in one serialize pass. Used by the save handler to make
   * the coalescing decision (dedup against the head revision's hash) before
   * deciding whether to write a new R2 object at all.
   */
  async function contentDigest(
    content: DocContent
  ): Promise<{ contentHash: string; byteSize: number }> {
    const body = serialize(content)
    return { contentHash: await sha256Hex(body), byteSize: body.byteLength }
  }

  /**
   * Write ONLY the materialised snapshot (no new revision). Keeps the read
   * snapshot truthful when content changed outside the explicit save path
   * (e.g. the collab DO reconciling from the authoritative Y.Doc).
   */
  async function writeMaterializedSnapshot(
    env: Env,
    id: string,
    content: DocContent
  ): Promise<string> {
    const body = serialize(content)
    const contentHash = await sha256Hex(body)
    await env.DOCS_BUCKET.put(snapshotKey(id), body, {
      httpMetadata: { contentType: CONTENT_TYPE },
      customMetadata: { contentHash }
    })
    return contentHash
  }

  /**
   * Best-effort bulk delete of revision bodies whose D1 rows the retention
   * prune removed. Chunked to R2's 1000-key-per-call limit. An orphaned
   * object (delete fails) is harmless — nothing references it — so callers
   * run this in waitUntil and only log failures.
   */
  async function deleteRevisionObjects(env: Env, keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 1000) {
      await env.DOCS_BUCKET.delete(keys.slice(i, i + 1000))
    }
  }

  /** Load a specific revision. Returns null if missing (e.g. R2 pruned). */
  async function readRevision(
    env: Env,
    id: string,
    revisionId: string
  ): Promise<DocContent | null> {
    const obj = await env.DOCS_BUCKET.get(revisionKey(id, revisionId))
    if (!obj) return null
    return parse(await obj.arrayBuffer())
  }

  /**
   * Restore a previous revision: copy its bytes to a fresh revision id
   * and refresh the snapshot. Equivalent to "save the old content as a
   * new revision" so the timeline stays append-only.
   */
  async function restoreFromRevision(
    env: Env,
    id: string,
    fromRevisionId: string,
    newRevisionId: string
  ): Promise<PutResult | null> {
    const content = await readRevision(env, id, fromRevisionId)
    if (!content) return null
    return writeRevisionAndSnapshot(env, id, newRevisionId, content)
  }

  return {
    writeRevisionAndSnapshot,
    readSnapshot,
    readSnapshotHash,
    hashContent,
    contentDigest,
    writeMaterializedSnapshot,
    deleteRevisionObjects,
    readRevision,
    restoreFromRevision
  }
}

function serialize(content: DocContent): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(content))
}

function parse(buf: ArrayBuffer): DocContent {
  return JSON.parse(new TextDecoder().decode(buf)) as DocContent
}
