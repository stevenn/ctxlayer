/**
 * Body of PUT /api/docs/:id/content — size/shape validation, revision
 * coalescing, autosave retention, and git-doc divergence flagging.
 * Extracted from `api/docs.ts` to keep the route thin; the edit gate
 * stays in the route and all SQL stays in `db/queries/*`.
 *
 * Save flow:
 *   1. write revision + snapshot to R2 (revision first, so a partial
 *      failure preserves the old snapshot)
 *   2. INSERT doc_revisions + UPDATE documents.current_rev_id
 *   3. waitUntil-enqueue {docId, revisionId} to DOC_REINDEX_QUEUE
 */

import { DocContent } from '@ctxlayer/shared'
import type { ZodIssue } from 'zod'
import type { Env } from '../env'
import {
  amendRevision,
  getHeadRevision,
  pruneAutosaveRevisions,
  recordRevision,
  sealRevision
} from '../db/queries/docs'
import { decideRevision, MAX_RETAINED_AUTOSAVES } from '../db/revision-policy'
import { markGitDocLocallyEdited } from '../db/queries/git-sources'
import {
  contentDigest,
  deleteRevisionObjects,
  writeRevisionAndSnapshot
} from '../storage/docs-r2'

const CONTENT_MAX_BYTES = 2 * 1024 * 1024

export type SaveDocContentResult =
  | { status: 200; body: { revisionId: string; byteSize: number; contentHash: string } }
  | { status: 400; body: { error: 'bad_request'; issues: ZodIssue[] } }
  | { status: 413; body: { error: 'content_too_large' } }

export async function saveDocContent(
  env: Env,
  executionCtx: ExecutionContext,
  args: { docId: string; userId: string; raw: ArrayBuffer; explicit: boolean }
): Promise<SaveDocContentResult> {
  const { docId, userId, raw, explicit } = args
  if (raw.byteLength > CONTENT_MAX_BYTES) {
    return { status: 413, body: { error: 'content_too_large' } }
  }
  const parsed = DocContent.safeParse(JSON.parse(new TextDecoder().decode(raw) || 'null'))
  if (!parsed.success) {
    return { status: 400, body: { error: 'bad_request', issues: parsed.error.issues } }
  }

  // Coalescing policy: a background autosave folds into the rolling
  // autosave head; only an explicit save cuts a distinct checkpoint.
  // Identical content is a no-op. See db/revision-policy.ts.
  const { contentHash, byteSize } = await contentDigest(parsed.data)
  const head = await getHeadRevision(env, docId)
  const decision = decideRevision(head, {
    contentHash,
    userId,
    explicit,
    now: Math.floor(Date.now() / 1000)
  })

  if (decision.action === 'noop') {
    return { status: 200, body: { revisionId: decision.revisionId, byteSize, contentHash } }
  }
  if (decision.action === 'seal') {
    await sealRevision(env, docId, decision.revisionId)
    return { status: 200, body: { revisionId: decision.revisionId, byteSize, contentHash } }
  }

  const revisionId = decision.action === 'amend' ? decision.revisionId : newRevisionId()
  const put = await writeRevisionAndSnapshot(env, docId, revisionId, parsed.data)
  if (decision.action === 'amend') {
    await amendRevision(env, {
      docId,
      revisionId,
      byteSize: put.byteSize,
      contentHash: put.contentHash
    })
  } else {
    await recordRevision(env, {
      docId,
      revisionId,
      authorId: userId,
      r2Key: put.key,
      byteSize: put.byteSize,
      contentHash: put.contentHash,
      kind: decision.kind
    })
    // Retention: a new row may push the autosave count over the cap.
    // Prune the oldest autosaves (D1) now; drop their R2 bodies after the
    // response (best-effort — orphaned objects are harmless).
    const prunedKeys = await pruneAutosaveRevisions(env, docId, MAX_RETAINED_AUTOSAVES)
    if (prunedKeys.length > 0) {
      executionCtx.waitUntil(
        deleteRevisionObjects(env, prunedKeys).catch((err) =>
          console.error('autosave prune R2 cleanup failed', err)
        )
      )
    }
  }
  // A local edit diverges a git-sourced doc from its synced baseline. Flag it
  // (clean → local_edits) so inbound cron sync won't clobber the edit before
  // it's proposed as a PR. No-op for ordinary (non-git) docs.
  await markGitDocLocallyEdited(env, docId)
  executionCtx.waitUntil(
    env.DOC_REINDEX_QUEUE.send({ docId, revisionId }).catch((err) =>
      console.error('reindex enqueue failed', err)
    )
  )
  return {
    status: 200,
    body: { revisionId, byteSize: put.byteSize, contentHash: put.contentHash }
  }
}

function newRevisionId(): string {
  return crypto.randomUUID().replace(/-/g, '')
}
