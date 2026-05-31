/**
 * Outbound write-back: turn an editor edit into a PR/MR against the
 * source's pinned branch.
 *
 * Diff-churn control: normalise both the synced baseline (source.md) and
 * the edited markdown; if equal, it's a no-op. Otherwise commit the
 * normalised content onto a per-doc head branch (stable across edits, so
 * a second edit updates the same PR) and open/refresh the PR.
 *
 * Authorship: the acting user's token (write_strategy) when connected,
 * else the shared org token (bot author). After a push we update
 * source.md to the committed content + reindex so RAG reflects the
 * proposed edit, and mark the doc `pr_open`.
 */

import type { Env } from '../env'
import type { CreatePullRequestResult } from '@ctxlayer/shared'
import { getDocById } from '../db/queries/docs'
import {
  getDocGitOrigin,
  getGitSourceById,
  getOpenPrForDoc,
  insertGitPr,
  setDocGitSyncState,
  type GitSourceRow
} from '../db/queries/git-sources'
import { readSourceMarkdown, writeSourceMarkdown } from '../storage/docs-r2'
import { createGitProvider, type GitRepoConfig } from './provider'
import { resolveGitWriteToken } from './credentials'
import { normalizeMarkdown } from './markdown-normalize'

export type WriteBackOutcome =
  | { ok: true; result: CreatePullRequestResult }
  | { ok: false; status: number; error: string }

export async function openWriteBackPr(
  env: Env,
  docId: string,
  input: { actorId: string; markdown: string }
): Promise<WriteBackOutcome> {
  const doc = await getDocById(env, docId)
  if (!doc) return { ok: false, status: 404, error: 'not_found' }

  const origin = await getDocGitOrigin(env, docId)
  if (!origin) return { ok: false, status: 400, error: 'not_a_git_doc' }
  const source = await getGitSourceById(env, origin.git_source_id)
  if (!source) return { ok: false, status: 400, error: 'source_gone' }

  const normalized = normalizeMarkdown(input.markdown)
  const baseline = normalizeMarkdown((await readSourceMarkdown(env, docId)) ?? '')
  const openPr = await getOpenPrForDoc(env, docId)

  if (normalized === baseline) {
    return {
      ok: true,
      result: {
        outcome: 'noop',
        pr: openPr ? { url: openPr.url, providerPrId: openPr.provider_pr_id, state: 'open' } : null
      }
    }
  }

  const write = await resolveGitWriteToken(env, source, input.actorId)
  if (!write) return { ok: false, status: 400, error: 'no_write_token' }

  const provider = createGitProvider(repoConfig(source), write.token)
  const branchName = openPr?.branch_name ?? `ctxlayer/doc-${doc.slug}-${shortId()}`
  const base = env.PUBLIC_BASE_URL.replace(/\/+$/, '')

  let opened
  try {
    opened = await provider.openOrUpdatePullRequest({
      baseRef: source.branch,
      headBranch: branchName,
      existingBranch: openPr?.branch_name,
      path: origin.git_path,
      content: normalized,
      commitMessage: `docs: update ${origin.git_path} via ctxlayer`,
      prTitle: `Update ${origin.git_path}`,
      prBody: `Proposed from ctxlayer.\n\nDoc: ${base}/app/docs/${docId}`
    })
  } catch (err) {
    // Never echo provider error text to the caller.
    console.error(`git-writeback: ${doc.slug} -> ${err instanceof Error ? err.message : 'error'}`)
    return { ok: false, status: 502, error: 'git_write_failed' }
  }

  if (!openPr) {
    await insertGitPr(env, {
      gitSourceId: source.id,
      docId,
      branchName: opened.branchName,
      providerPrId: opened.providerPrId,
      url: opened.url,
      openedBy: input.actorId,
      baseCommitSha: origin.git_commit_sha
    })
  }

  // Reflect the proposed edit locally: source.md becomes the new diff
  // baseline (so re-saving identical content is a no-op) and RAG reindexes.
  await writeSourceMarkdown(env, docId, normalized)
  await setDocGitSyncState(env, docId, 'pr_open')
  await env.DOC_REINDEX_QUEUE.send({
    docId,
    revisionId: origin.git_commit_sha ?? `pr:${opened.providerPrId}`,
    source: 'git'
  }).catch((e) => console.error('git-writeback reindex enqueue failed', e))

  return {
    ok: true,
    result: {
      outcome: openPr ? 'updated' : 'opened',
      pr: { url: opened.url, providerPrId: opened.providerPrId, state: 'open' }
    }
  }
}

function repoConfig(s: GitSourceRow): GitRepoConfig {
  return { provider: s.provider, baseUrl: s.base_url, owner: s.owner, project: s.project, repo: s.repo }
}

function shortId(): string {
  const b = crypto.getRandomValues(new Uint8Array(4))
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
}
