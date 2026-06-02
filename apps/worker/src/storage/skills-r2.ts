/**
 * R2 layout for skill bodies. Mirrors docs-r2.ts; reuses DOCS_BUCKET.
 *
 *   skills/{skillId}/snapshot.json           -- always reflects current_rev
 *   skills/{skillId}/revisions/{revId}.json  -- immutable per-save copies
 *
 * Body shape is the same BlockNote block tree as docs (DocContent from
 * @ctxlayer/shared, re-exported there as SkillContent).
 */

import type { Env } from '../env'
import type { DocContent } from '@ctxlayer/shared'

const CONTENT_TYPE = 'application/json; charset=utf-8'

export function snapshotKey(skillId: string): string {
  return `skills/${skillId}/snapshot.json`
}

export function revisionKey(skillId: string, revisionId: string): string {
  return `skills/${skillId}/revisions/${revisionId}.json`
}

export interface PutResult {
  key: string
  byteSize: number
  contentHash: string
}

export async function writeRevisionAndSnapshot(
  env: Env,
  skillId: string,
  revisionId: string,
  content: DocContent
): Promise<PutResult> {
  const body = serialize(content)
  const contentHash = await sha256Hex(body)
  const byteSize = body.byteLength

  await env.DOCS_BUCKET.put(revisionKey(skillId, revisionId), body, {
    httpMetadata: { contentType: CONTENT_TYPE },
    customMetadata: { contentHash, revisionId }
  })
  await env.DOCS_BUCKET.put(snapshotKey(skillId), body, {
    httpMetadata: { contentType: CONTENT_TYPE },
    customMetadata: { contentHash, revisionId }
  })

  return { key: revisionKey(skillId, revisionId), byteSize, contentHash }
}

export async function readSnapshot(env: Env, skillId: string): Promise<DocContent | null> {
  const obj = await env.DOCS_BUCKET.get(snapshotKey(skillId))
  if (!obj) return null
  return parse(await obj.arrayBuffer())
}

export async function readRevision(
  env: Env,
  skillId: string,
  revisionId: string
): Promise<DocContent | null> {
  const obj = await env.DOCS_BUCKET.get(revisionKey(skillId, revisionId))
  if (!obj) return null
  return parse(await obj.arrayBuffer())
}

/**
 * Restore a previous revision: copy its bytes to a fresh revision id and
 * refresh the snapshot. Mirrors docs-r2's restoreFromRevision — "save the
 * old content as a new revision" so the timeline stays append-only.
 */
export async function restoreFromRevision(
  env: Env,
  skillId: string,
  fromRevisionId: string,
  newRevisionId: string
): Promise<PutResult | null> {
  const content = await readRevision(env, skillId, fromRevisionId)
  if (!content) return null
  return writeRevisionAndSnapshot(env, skillId, newRevisionId, content)
}

function serialize(content: DocContent): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(content))
}

function parse(buf: ArrayBuffer): DocContent {
  return JSON.parse(new TextDecoder().decode(buf)) as DocContent
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const view = new Uint8Array(digest)
  let hex = ''
  for (const b of view) hex += b.toString(16).padStart(2, '0')
  return hex
}
