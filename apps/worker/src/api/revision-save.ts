/**
 * Shared body of "PUT :id/content" for revisioned entities (docs and
 * skills): size/shape validation, the coalescing decision, the R2
 * revision+snapshot write, amend/record, and autosave retention. The
 * two call sites keep their entity-specific side effects — git
 * divergence flag + reindex enqueue for docs, the reference linter for
 * skills — keyed off `wrote` (false when the save was a noop/seal and
 * no new body was persisted).
 */

import { DocContent } from '@ctxlayer/shared'
import type { ZodIssue } from 'zod'
import type { Env } from '../env'
import { decideRevision, MAX_RETAINED_AUTOSAVES, type HeadRevision } from '../db/revision-policy'
import type { RecordRevisionInputBase } from '../db/queries/revision-queries'
import { newId } from '../db/queries/util'
import type { PutResult } from '../storage/revision-store'

export const CONTENT_MAX_BYTES = 2 * 1024 * 1024

export interface RevisionSaveDeps {
  /** The entity's `makeRevisionQueries` instance (docs.ts / skills.ts). */
  queries: {
    head(env: Env, parentId: string): Promise<HeadRevision | null>
    seal(env: Env, parentId: string, revisionId: string): Promise<void>
    amend(
      env: Env,
      input: { parentId: string; revisionId: string; byteSize: number; contentHash: string }
    ): Promise<void>
    record(env: Env, input: RecordRevisionInputBase): Promise<unknown>
    pruneAutosaves(env: Env, parentId: string, keep: number): Promise<string[]>
  }
  /** The entity's `makeRevisionStore` members (docs-r2 / skills-r2). */
  contentDigest(content: DocContent): Promise<{ contentHash: string; byteSize: number }>
  writeRevisionAndSnapshot(
    env: Env,
    id: string,
    revisionId: string,
    content: DocContent
  ): Promise<PutResult>
  deleteRevisionObjects(env: Env, keys: string[]): Promise<unknown>
}

export type RevisionSaveOutcome =
  | { kind: 'too_large' }
  | { kind: 'invalid'; issues: ZodIssue[] }
  | {
      kind: 'saved'
      revisionId: string
      byteSize: number
      contentHash: string
      /** False when the content was a noop/seal — nothing new persisted. */
      wrote: boolean
      content: DocContent
    }

export async function saveRevisionContent(
  env: Env,
  executionCtx: ExecutionContext,
  deps: RevisionSaveDeps,
  args: { parentId: string; userId: string; raw: ArrayBuffer; explicit: boolean }
): Promise<RevisionSaveOutcome> {
  const { parentId, userId, raw, explicit } = args
  if (raw.byteLength > CONTENT_MAX_BYTES) return { kind: 'too_large' }
  const parsed = DocContent.safeParse(JSON.parse(new TextDecoder().decode(raw) || 'null'))
  if (!parsed.success) return { kind: 'invalid', issues: parsed.error.issues }

  // Coalescing policy: a background autosave folds into the rolling
  // autosave head; only an explicit save cuts a distinct checkpoint.
  // Identical content is a no-op. See db/revision-policy.ts.
  const { contentHash, byteSize } = await deps.contentDigest(parsed.data)
  const head = await deps.queries.head(env, parentId)
  const decision = decideRevision(head, {
    contentHash,
    userId,
    explicit,
    now: Math.floor(Date.now() / 1000)
  })

  if (decision.action === 'noop' || decision.action === 'seal') {
    if (decision.action === 'seal') await deps.queries.seal(env, parentId, decision.revisionId)
    return {
      kind: 'saved',
      revisionId: decision.revisionId,
      byteSize,
      contentHash,
      wrote: false,
      content: parsed.data
    }
  }

  const revisionId = decision.action === 'amend' ? decision.revisionId : newId()
  const put = await deps.writeRevisionAndSnapshot(env, parentId, revisionId, parsed.data)
  if (decision.action === 'amend') {
    await deps.queries.amend(env, {
      parentId,
      revisionId,
      byteSize: put.byteSize,
      contentHash: put.contentHash
    })
  } else {
    await deps.queries.record(env, {
      parentId,
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
    const prunedKeys = await deps.queries.pruneAutosaves(env, parentId, MAX_RETAINED_AUTOSAVES)
    if (prunedKeys.length > 0) {
      executionCtx.waitUntil(
        deps.deleteRevisionObjects(env, prunedKeys).catch((err) =>
          console.error('autosave prune R2 cleanup failed', err)
        )
      )
    }
  }
  return {
    kind: 'saved',
    revisionId,
    byteSize: put.byteSize,
    contentHash: put.contentHash,
    wrote: true,
    content: parsed.data
  }
}
