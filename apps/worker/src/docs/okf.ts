/**
 * OKF (Open Knowledge Format) serialisation: turn a doc's current rail state
 * back into a `---`-fenced markdown file, and re-attach frontmatter on git
 * write-back. The inverse of the import-side parse in `git/sync.ts` +
 * `ImportDocModal`. Frontmatter shaping lives in `@ctxlayer/shared`; this
 * module is the worker glue that reads the doc's columns, tags, and body.
 *
 * Spec: https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md
 * Reference: docs/plan/M-okf.md
 */

import type { Env } from '../env'
import { emitFrontmatter, splitFrontmatter, type OkfKnownFields } from '@ctxlayer/shared'
import { getDocForOkfExport, type DocOkfExportRow } from '../db/queries/docs'
import { listTagsForDoc } from '../db/queries/doc-tags'
import { readSnapshot, readSourceMarkdown } from '../storage/docs-r2'
import { renderBlocksToMarkdown } from '../rag/markdown'

interface BlockOpts {
  /** Synthesise OKF `type` from `kind` when the doc has no explicit type. */
  synthesizeType: boolean
  /** Emit `timestamp: <updated_at>`. Off for write-back to avoid diff churn. */
  includeTimestamp: boolean
}

/**
 * Build the frontmatter block from the doc's rail state. Managed keys (type,
 * title, description, resource, tags, +timestamp on export) overlay the
 * preserved raw block; unknown producer keys ride through verbatim. `type` is
 * left *unmanaged* (preserved from raw) when there's no explicit type and
 * we're not synthesising, so write-back never strips a producer's type.
 */
export function okfFrontmatterBlock(
  row: DocOkfExportRow,
  tags: string[],
  opts: BlockOpts
): string {
  const fields: OkfKnownFields = {
    title: row.title,
    description: row.description,
    resource: row.resource,
    tags
  }
  if (row.doc_type != null) fields.type = row.doc_type
  // OKF requires `type`. When the doc has no explicit one, synthesise a
  // neutral concept label. `type` is now the single concept field (the old
  // `kind` enum is no longer surfaced), so the default is a plain 'Document'.
  else if (opts.synthesizeType) fields.type = 'Document'
  if (opts.includeTimestamp) fields.timestamp = new Date(row.updated_at * 1000).toISOString()
  return emitFrontmatter(fields, row.okf_frontmatter)
}

/**
 * The doc's markdown body. A clean git doc exports its exact imported
 * source.md (frontmatter stripped) — lossless. Anything else (edited git
 * doc, authored doc) renders from the current BlockNote snapshot, which is
 * the lossy-but-current state.
 */
export async function okfBody(env: Env, row: DocOkfExportRow): Promise<string> {
  const clean = row.git_sync_state === null || row.git_sync_state === 'clean'
  if (row.git_source_id && clean) {
    const src = await readSourceMarkdown(env, row.id)
    if (src !== null) return splitFrontmatter(src).body.replace(/^\s+/, '')
  }
  const snap = await readSnapshot(env, row.id)
  return snap ? renderBlocksToMarkdown(snap.blocks) : ''
}

/** Compose a full OKF markdown export for download, or null if the doc is gone. */
export async function composeOkfExport(
  env: Env,
  docId: string
): Promise<{ markdown: string; filename: string } | null> {
  const row = await getDocForOkfExport(env, docId)
  if (!row) return null
  const tags = (await listTagsForDoc(env, docId)).tags
  const block = okfFrontmatterBlock(row, tags, { synthesizeType: true, includeTimestamp: true })
  const body = await okfBody(env, row)
  return { markdown: block + body.replace(/^\n+/, ''), filename: `${row.slug}.md` }
}

/**
 * Re-attach frontmatter to an edited body before git write-back, so a PR
 * keeps/refreshes the OKF block instead of dropping it. Only docs that were
 * imported WITH frontmatter (okf_frontmatter not null) get a block — a
 * previously-plain repo file stays plain. No timestamp (avoids churn) and no
 * type synthesis (preserve the producer's type via the raw block).
 */
export async function okfReattachForWriteBack(
  env: Env,
  docId: string,
  body: string
): Promise<string> {
  const row = await getDocForOkfExport(env, docId)
  if (!row || row.okf_frontmatter === null) return body
  const tags = (await listTagsForDoc(env, docId)).tags
  const block = okfFrontmatterBlock(row, tags, {
    synthesizeType: false,
    includeTimestamp: false
  })
  return block ? block + body : body
}
