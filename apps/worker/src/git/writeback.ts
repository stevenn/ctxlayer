/**
 * Outbound write-back: turn an editor edit into a PR/MR against the
 * source's pinned branch.
 *
 * Two modes share one prelude (`setupWriteBack`):
 *   - `openWriteBackPr` — commit + open/refresh the PR via API, track it, and
 *     update the local baseline so RAG reflects the proposal.
 *   - `prepareWriteBackRedirect` — commit the branch only, then return the
 *     provider's New-PR deep-link so the user reviews + opens it in the
 *     provider UI. No PR tracking (we never see the resulting PR id) and no
 *     local-state mutation — minimal, honest side effects.
 *
 * Diff-churn control: normalise both the synced baseline (source.md) and the
 * edited markdown; if equal, it's a no-op. Authorship: the acting user's token
 * (write_strategy) when connected, else the shared org token (bot author).
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
  type GitDocOrigin,
  type GitPrRow,
  type GitSourceRow
} from '../db/queries/git-sources'
import { readSourceMarkdown, writeSourceMarkdown } from '../storage/docs-r2'
import { createGitProvider, type GitProviderClient, type GitRepoConfig } from './provider'
import { resolveGitWriteToken } from './credentials'
import { normalizeMarkdown } from './markdown-normalize'

export type WriteBackOutcome =
  | { ok: true; result: CreatePullRequestResult }
  | { ok: false; status: number; error: string }

export type ReviewUrlOutcome =
  | { ok: true; result: { redirectUrl: string | null; branch: string | null } }
  | { ok: false; status: number; error: string }

type WriteBackSetup =
  | { kind: 'error'; status: number; error: string }
  | { kind: 'noop'; openPr: GitPrRow | null }
  | {
      kind: 'ready'
      provider: GitProviderClient
      origin: GitDocOrigin
      source: GitSourceRow
      normalized: string
      branchName: string
      openPr: GitPrRow | null
      base: string
      slug: string
    }

/**
 * Shared prelude: validate the git doc, diff against the synced baseline,
 * resolve the write token, and build the provider client + deterministic
 * branch name. Returns a discriminated result both write-back modes consume.
 */
async function setupWriteBack(
  env: Env,
  docId: string,
  input: { actorId: string; markdown: string }
): Promise<WriteBackSetup> {
  const doc = await getDocById(env, docId)
  if (!doc) return { kind: 'error', status: 404, error: 'not_found' }

  const origin = await getDocGitOrigin(env, docId)
  if (!origin) return { kind: 'error', status: 400, error: 'not_a_git_doc' }
  const source = await getGitSourceById(env, origin.git_source_id)
  if (!source) return { kind: 'error', status: 400, error: 'source_gone' }

  const normalized = normalizeMarkdown(input.markdown)
  const baseline = normalizeMarkdown((await readSourceMarkdown(env, docId)) ?? '')
  const openPr = await getOpenPrForDoc(env, docId)
  if (normalized === baseline) return { kind: 'noop', openPr }

  const write = await resolveGitWriteToken(env, source, input.actorId)
  if (!write) return { kind: 'error', status: 400, error: 'no_write_token' }

  const provider = createGitProvider(repoConfig(source), write.token)
  // Deterministic per doc: a crash-retry regenerates the SAME branch, so the
  // provider finds + updates the existing PR instead of opening a duplicate.
  const branchName = openPr?.branch_name ?? stableBranchName(doc.slug, docId)
  const base = env.PUBLIC_BASE_URL.replace(/\/+$/, '')
  return {
    kind: 'ready',
    provider,
    origin,
    source,
    normalized,
    branchName,
    openPr,
    base,
    slug: doc.slug
  }
}

export async function openWriteBackPr(
  env: Env,
  docId: string,
  input: { actorId: string; markdown: string }
): Promise<WriteBackOutcome> {
  const s = await setupWriteBack(env, docId, input)
  if (s.kind === 'error') return { ok: false, status: s.status, error: s.error }
  if (s.kind === 'noop') {
    return {
      ok: true,
      result: {
        outcome: 'noop',
        pr: s.openPr
          ? { url: s.openPr.url, providerPrId: s.openPr.provider_pr_id, state: 'open' }
          : null
      }
    }
  }

  const { provider, origin, source, normalized, branchName, openPr, base } = s
  let opened: Awaited<ReturnType<typeof provider.openOrUpdatePullRequest>>
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
    console.error(`git-writeback: ${s.slug} -> ${err instanceof Error ? err.message : 'error'}`)
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

  // Reflect the proposed edit locally: source.md becomes the new diff baseline
  // (so re-saving identical content is a no-op) and RAG reindexes.
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

/**
 * Commit the change onto the head branch, then return the provider's New-PR
 * deep-link for the user to review + open in the provider UI. We do NOT open
 * the PR (so there's no PR id to track) and do NOT mutate local state — the
 * only effect is the pushed branch. A no-op with an already-open PR returns
 * that PR's URL.
 */
export async function prepareWriteBackRedirect(
  env: Env,
  docId: string,
  input: { actorId: string; markdown: string }
): Promise<ReviewUrlOutcome> {
  const s = await setupWriteBack(env, docId, input)
  if (s.kind === 'error') return { ok: false, status: s.status, error: s.error }
  if (s.kind === 'noop') {
    return {
      ok: true,
      result: { redirectUrl: s.openPr?.url ?? null, branch: s.openPr?.branch_name ?? null }
    }
  }

  const { provider, origin, source, normalized, branchName, base } = s
  const title = `Update ${origin.git_path}`
  const body = `Proposed from ctxlayer.\n\nDoc: ${base}/app/docs/${docId}`
  try {
    await provider.commitChange({
      baseRef: source.branch,
      headBranch: branchName,
      existingBranch: s.openPr?.branch_name,
      path: origin.git_path,
      content: normalized,
      commitMessage: `docs: update ${origin.git_path} via ctxlayer`,
      prTitle: title,
      prBody: body
    })
  } catch (err) {
    console.error(`git-review-url: ${s.slug} -> ${err instanceof Error ? err.message : 'error'}`)
    return { ok: false, status: 502, error: 'git_write_failed' }
  }

  const redirectUrl = provider.newPrWebUrl({
    headBranch: branchName,
    baseRef: source.branch,
    title,
    body
  })
  return { ok: true, result: { redirectUrl, branch: branchName } }
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

/**
 * Stable head-branch name for a doc's write-back PR. slug for reviewer
 * readability, an 8-char docId suffix for collision-freedom + stability
 * across slug renames. Deterministic so a crash-retry can't spawn a second
 * branch/PR (see call site).
 */
function stableBranchName(slug: string, docId: string): string {
  return `ctxlayer/doc-${slug}-${docId.slice(0, 8)}`
}
