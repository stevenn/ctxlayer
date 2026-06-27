/**
 * Generic git-provider interface + shared shapes, parallel to the
 * upstream `UpstreamClient`. Concrete implementations (github.ts /
 * gitlab.ts / azure.ts) implement `GitProviderClient` and sit behind
 * `createGitProvider` in `provider.ts` — this module imports no
 * implementation, so the dependency graph stays one-way.
 *
 * We never clone a repo: each method is a REST call. Reads list the
 * markdown tree + fetch single files; writes create a branch, commit a
 * file, and open a PR/MR. The deep-link is built from the configured
 * branch name (human-facing), not the resolved commit sha.
 */

import type { GitProvider, GitPrState } from '@ctxlayer/shared'

export interface GitTreeEntry {
  /** Repo-relative path, e.g. 'docs/setup.md'. */
  path: string
  /** Provider blob/object id — the change-detection key. */
  blobSha: string
  size: number
}

export interface GitFileContent {
  blobSha: string
  /** Decoded UTF-8 markdown. */
  text: string
}

export interface OpenedPr {
  providerPrId: string
  url: string
  branchName: string
}

export interface OpenOrUpdatePrInput {
  /** Branch we open the PR against (the source's pinned branch). */
  baseRef: string
  /** ctxlayer-managed head branch to commit onto. */
  headBranch: string
  /** When set, push to this existing head branch instead of creating one. */
  existingBranch?: string
  path: string
  /** New file content (raw markdown). */
  content: string
  commitMessage: string
  prTitle: string
  prBody: string
}

/** Inputs for the "open this PR in the browser" deep-link (no API PR open). */
export interface NewPrUrlInput {
  headBranch: string
  baseRef: string
  title: string
  body: string
}

export interface GitProviderClient {
  /** Resolve a ref (branch name) to the commit sha it points at. */
  resolveRef(ref: string): Promise<string>
  /**
   * The repo's default branch as a BARE name (e.g. `main` / `master`), or
   * null when the provider can't report one (empty repo / no commits). Used
   * to auto-detect when a source's branch is left blank, and to name the
   * real default in a "branch not found" error.
   */
  getDefaultBranch(): Promise<string | null>
  /** List *.md blobs on `ref`, optionally restricted to `pathPrefix`. */
  listMarkdownTree(ref: string, pathPrefix: string): Promise<GitTreeEntry[]>
  /** Read one file's decoded content + blob sha at `ref`. */
  readFile(path: string, ref: string): Promise<GitFileContent>
  /** Web deep-link to the file on the host. */
  blobWebUrl(path: string, ref: string): string
  /** Create-or-update a head branch and commit the file — WITHOUT opening a PR. */
  commitChange(input: OpenOrUpdatePrInput): Promise<void>
  /** Create-or-update a head branch, commit the file, open/refresh a PR. */
  openOrUpdatePullRequest(input: OpenOrUpdatePrInput): Promise<OpenedPr>
  /**
   * Web deep-link to the provider's "New PR/MR" page for an already-pushed
   * head branch, prefilled where the provider supports it. Lets the user
   * review the diff and click the final button in the provider's own UI.
   */
  newPrWebUrl(input: NewPrUrlInput): string
  /** Poll PR/MR state for the SPA status badge. */
  getPullRequestState(providerPrId: string): Promise<GitPrState>
}

export interface GitRepoConfig {
  provider: GitProvider
  baseUrl: string | null
  owner: string
  project: string
  repo: string
}
