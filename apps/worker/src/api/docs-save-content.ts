/**
 * Body of PUT /api/docs/:id/content. The generic pipeline — size/shape
 * validation, revision coalescing, R2 revision+snapshot write, autosave
 * retention — lives in `api/revision-save.ts` (shared with the skills
 * save route); this wrapper keeps the doc-only side effects: git-doc
 * divergence flagging and the reindex enqueue. The edit gate stays in
 * the route (`api/docs.ts`) and all SQL stays in `db/queries/*`.
 */

import type { ZodIssue } from 'zod'
import type { Env } from '../env'
import { docRevisionQueries } from '../db/queries/docs'
import { markGitDocLocallyEdited } from '../db/queries/git-sources'
import {
  contentDigest,
  deleteRevisionObjects,
  writeRevisionAndSnapshot
} from '../storage/docs-r2'
import { saveRevisionContent } from './revision-save'

export type SaveDocContentResult =
  | { status: 200; body: { revisionId: string; byteSize: number; contentHash: string } }
  | { status: 400; body: { error: 'bad_request'; issues: ZodIssue[] } }
  | { status: 413; body: { error: 'content_too_large' } }

export async function saveDocContent(
  env: Env,
  executionCtx: ExecutionContext,
  args: { docId: string; userId: string; raw: ArrayBuffer; explicit: boolean }
): Promise<SaveDocContentResult> {
  const outcome = await saveRevisionContent(
    env,
    executionCtx,
    { queries: docRevisionQueries, contentDigest, writeRevisionAndSnapshot, deleteRevisionObjects },
    { parentId: args.docId, userId: args.userId, raw: args.raw, explicit: args.explicit }
  )
  if (outcome.kind === 'too_large') return { status: 413, body: { error: 'content_too_large' } }
  if (outcome.kind === 'invalid') {
    return { status: 400, body: { error: 'bad_request', issues: outcome.issues } }
  }
  if (outcome.wrote) {
    // A local edit diverges a git-sourced doc from its synced baseline. Flag it
    // (clean → local_edits) so inbound cron sync won't clobber the edit before
    // it's proposed as a PR. No-op for ordinary (non-git) docs.
    // B2 (2026-08 review): the DocRoomDO now fires the same flag + a
    // debounced reindex on every ACTUAL materialised write, so these two
    // side effects are belt-and-suspenders here — this path remains the
    // sole trigger for REVISIONS (a deliberate, user-meaningful act).
    await markGitDocLocallyEdited(env, args.docId)
    executionCtx.waitUntil(
      env.DOC_REINDEX_QUEUE.send({ docId: args.docId, revisionId: outcome.revisionId }).catch(
        (err) => console.error('reindex enqueue failed', err)
      )
    )
  }
  return {
    status: 200,
    body: {
      revisionId: outcome.revisionId,
      byteSize: outcome.byteSize,
      contentHash: outcome.contentHash
    }
  }
}
