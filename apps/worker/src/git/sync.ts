/**
 * Inbound git sync: mirror *.md from a source's pinned branch into the
 * doc store, then enqueue reindex.
 *
 * Idempotent + change-aware: a doc whose stored blob sha matches the
 * tree entry is skipped (no fetch, no reindex). Docs with unmerged local
 * work (local_edits / pr_open) are marked `conflict` rather than
 * clobbered. Vanished blobs soft-delete their (clean) docs.
 *
 * Git-synced docs store raw markdown as the canonical body
 * (docs/{docId}/source.md); the reindex consumer chunks it directly and
 * the editor materialises BlockNote blocks lazily on first open.
 */

import type { Env } from '../env'
import type { GitSyncInterval, GitSyncResult } from '@ctxlayer/shared'
import { slugifyHeading } from '@ctxlayer/shared'
import {
  getGitSourceById,
  listGitDocPaths,
  markDocGitOrigin,
  recordSyncResult,
  setDocGitSyncState,
  type GitSourceRow
} from '../db/queries/git-sources'
import { createDoc, softDeleteDoc } from '../db/queries/docs'
import { setDocProductTag } from '../db/queries/doc-tags'
import { writeSourceMarkdown } from '../storage/docs-r2'
import { createGitProvider } from './provider'
import type { GitRepoConfig } from './provider-types'
import { resolveGitReadToken } from './credentials'

export interface RunGitSyncOpts {
  /** Acting user, for user_* read strategies (interactive sync). */
  userId?: string
}

// Minimum elapsed seconds between scheduled syncs per cadence. The
// hourly cron enqueues a source only once its interval has elapsed.
const SYNC_GAP_SECONDS: Record<GitSyncInterval, number> = {
  hourly: 3600,
  '6x_daily': 4 * 3600,
  '2x_daily': 12 * 3600,
  daily: 24 * 3600,
  weekly: 7 * 24 * 3600
}

/**
 * Whether a source is due for a scheduled sync. A 5-minute slack absorbs
 * cron jitter so a source that synced 59½ minutes ago isn't skipped on
 * the next hourly tick. Never-synced sources are always due.
 */
export function isGitSyncDue(
  interval: GitSyncInterval,
  lastSyncedAt: number | null,
  nowSec: number
): boolean {
  if (lastSyncedAt == null) return true
  const gap = SYNC_GAP_SECONDS[interval] ?? SYNC_GAP_SECONDS.daily
  return nowSec - lastSyncedAt >= gap - 300
}

const ZERO = { created: 0, updated: 0, deleted: 0, skipped: 0, conflicts: 0 }

export async function runGitSync(
  env: Env,
  sourceId: string,
  opts: RunGitSyncOpts = {}
): Promise<GitSyncResult> {
  const source = await getGitSourceById(env, sourceId)
  if (!source) return { status: 'error', ...ZERO, error: 'source_not_found' }
  if (source.enabled !== 1) return { status: 'error', ...ZERO, error: 'source_disabled' }

  const token = await resolveGitReadToken(env, source, { userId: opts.userId })
  if (!token) {
    await recordSyncResult(env, sourceId, 'error', 'no_read_token')
    return { status: 'error', ...ZERO, error: 'no_read_token' }
  }

  const provider = createGitProvider(repoConfig(source), token)
  const counts = { ...ZERO }

  try {
    const headSha = await provider.resolveRef(source.branch)
    const entries = await provider.listMarkdownTree(source.branch, source.path_prefix)
    const existing = await listGitDocPaths(env, sourceId)
    // One read up front instead of a per-path lookup per tree entry —
    // a no-op sync over a large repo used to cost one D1 round trip
    // per markdown file.
    const docByPath = new Map(existing.map((e) => [e.git_path, e]))
    const seen = new Set<string>()

    for (const entry of entries) {
      seen.add(entry.path)
      const doc = docByPath.get(entry.path) ?? null

      if (doc && doc.git_blob_sha === entry.blobSha) {
        counts.skipped++
        continue
      }
      if (doc && (doc.git_sync_state === 'local_edits' || doc.git_sync_state === 'pr_open')) {
        // Remote moved while we hold unmerged local work — flag, don't clobber.
        await setDocGitSyncState(env, doc.id, 'conflict')
        counts.conflicts++
        continue
      }

      const file = await provider.readFile(entry.path, source.branch)
      let docId: string
      if (doc) {
        docId = doc.id
      } else {
        const created = await createDoc(env, {
          title: deriveTitle(file.text, entry.path),
          folder: repoPathToFolder(source.folder_root, entry.path),
          createdBy: source.created_by
        })
        docId = created.id
      }
      await writeSourceMarkdown(env, docId, file.text)
      await markDocGitOrigin(env, docId, {
        sourceId,
        path: entry.path,
        blobSha: entry.blobSha,
        commitSha: headSha
      })
      // Auto-tag with the source's product (drives search_docs scope).
      // Set BEFORE the reindex enqueue so the consumer's tag read picks
      // it up. null clears any product tag (source has no product).
      await setDocProductTag(env, docId, source.product_id)
      // Reindex from source.md directly (revisionId = the commit we read at).
      await env.DOC_REINDEX_QUEUE.send({ docId, revisionId: headSha, source: 'git' })
      if (doc) counts.updated++
      else counts.created++
    }

    // Deletions: a doc whose path no longer appears in the tree. Only
    // drop clean docs — anything with local edits / an open PR is left
    // for the operator to resolve.
    for (const e of existing) {
      if (seen.has(e.git_path)) continue
      if (e.git_sync_state === null || e.git_sync_state === 'clean') {
        await softDeleteDoc(env, e.id)
        counts.deleted++
      }
    }

    const status: GitSyncResult['status'] = counts.conflicts > 0 ? 'partial' : 'ok'
    await recordSyncResult(env, sourceId, status, null)
    return { status, ...counts, error: null }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await recordSyncResult(env, sourceId, 'error', msg)
    return { status: 'error', ...counts, error: msg }
  }
}

function repoConfig(s: GitSourceRow): GitRepoConfig {
  return {
    provider: s.provider,
    baseUrl: s.base_url,
    owner: s.owner,
    project: s.project,
    repo: s.repo
  }
}

/** Title from the first H1, else the filename sans markdown extension. */
function deriveTitle(markdown: string, path: string): string {
  const h1 = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim()
  if (h1) return h1.slice(0, 200)
  const base = path.split('/').pop() ?? path
  return base.replace(/\.(md|mdown|markdown|mkd)$/i, '') || path
}

/**
 * Map a repo file path to a ctxlayer folder under `folderRoot`. Segments
 * are slugified (non-slug repo dirs become slug-shaped) and capped at
 * depth 5 to satisfy FolderPath. The true repo path is preserved on the
 * doc's git_path regardless; this is only for browse grouping.
 */
function repoPathToFolder(folderRoot: string, repoPath: string): string | null {
  const dir = repoPath.includes('/') ? repoPath.slice(0, repoPath.lastIndexOf('/')) : ''
  const rootSegs = folderRoot
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter(Boolean)
  const dirSegs = dir.split('/').filter(Boolean)
  const segs = [...rootSegs, ...dirSegs].map(slugifyHeading).filter(Boolean).slice(0, 5)
  return segs.length === 0 ? null : `/${segs.join('/')}`
}
