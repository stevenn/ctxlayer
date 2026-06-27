import {
  AdminGitSourceRow,
  CreateGitSourceRequest,
  CreatePullRequestRequest,
  CreatePullRequestResult,
  GitDocStatus,
  GitOAuthConfigRequest,
  GitReviewUrlResult,
  GitSetCredentialRequest,
  ReplaceVisibilityRequest,
  UpdateGitSourceRequest
} from '@ctxlayer/shared'
import { z } from 'zod'
import { request } from './core'

// ----- admin: git sources -------------------------------------------------

const AdminGitSourceList = z.array(AdminGitSourceRow)
const gitSourcePath = (id: string) => `/api/admin/git-sources/${encodeURIComponent(id)}`

export function fetchAdminGitSources(signal?: AbortSignal): Promise<AdminGitSourceRow[]> {
  return request('/api/admin/git-sources', (b) => AdminGitSourceList.parse(b), { signal })
}

export function fetchAdminGitSource(id: string, signal?: AbortSignal): Promise<AdminGitSourceRow> {
  return request(gitSourcePath(id), (b) => AdminGitSourceRow.parse(b), { signal })
}

export function adminCreateGitSource(input: CreateGitSourceRequest): Promise<AdminGitSourceRow> {
  return request('/api/admin/git-sources', (b) => AdminGitSourceRow.parse(b), {
    method: 'POST',
    body: JSON.stringify(CreateGitSourceRequest.parse(input))
  })
}

export function adminPatchGitSource(id: string, patch: UpdateGitSourceRequest): Promise<void> {
  return request(gitSourcePath(id), () => undefined, {
    method: 'PATCH',
    body: JSON.stringify(UpdateGitSourceRequest.parse(patch))
  })
}

export function adminDeleteGitSource(id: string): Promise<void> {
  return request(gitSourcePath(id), () => undefined, { method: 'DELETE' })
}

export function adminPutGitSourceVisibility(
  id: string,
  payload: ReplaceVisibilityRequest
): Promise<void> {
  return request(`${gitSourcePath(id)}/visibility`, () => undefined, {
    method: 'PUT',
    body: JSON.stringify(ReplaceVisibilityRequest.parse(payload))
  })
}

export function adminPutGitSharedCredential(id: string, body: { token: string }): Promise<void> {
  return request(`${gitSourcePath(id)}/shared-credentials`, () => undefined, {
    method: 'PUT',
    body: JSON.stringify(GitSetCredentialRequest.parse(body))
  })
}

export function adminDeleteGitSharedCredential(id: string): Promise<void> {
  return request(`${gitSourcePath(id)}/shared-credentials`, () => undefined, { method: 'DELETE' })
}

export function adminPutGitSourceOAuth(id: string, body: GitOAuthConfigRequest): Promise<void> {
  return request(`${gitSourcePath(id)}/oauth`, () => undefined, {
    method: 'PUT',
    body: JSON.stringify(GitOAuthConfigRequest.parse(body))
  })
}

export function adminDeleteGitSourceOAuth(id: string): Promise<void> {
  return request(`${gitSourcePath(id)}/oauth`, () => undefined, { method: 'DELETE' })
}

export function adminSyncGitSource(id: string): Promise<void> {
  return request(`${gitSourcePath(id)}/sync`, () => undefined, { method: 'POST' })
}

// ----- per-doc git status / write-back ------------------------------------

const GitDocSource = z.object({ markdown: z.string() })

// 404 ⇒ the doc isn't git-backed; callers treat that as "no git panel".
export function fetchDocGitStatus(id: string, signal?: AbortSignal): Promise<GitDocStatus> {
  return request(`/api/docs/${encodeURIComponent(id)}/git`, (b) => GitDocStatus.parse(b), {
    signal
  })
}

export function fetchDocGitSource(id: string, signal?: AbortSignal): Promise<{ markdown: string }> {
  return request(`/api/docs/${encodeURIComponent(id)}/git/source`, (b) => GitDocSource.parse(b), {
    signal
  })
}

export function proposeGitPullRequest(
  id: string,
  markdown: string
): Promise<CreatePullRequestResult> {
  return request(
    `/api/docs/${encodeURIComponent(id)}/git/pull-request`,
    (b) => CreatePullRequestResult.parse(b),
    {
      method: 'POST',
      body: JSON.stringify(CreatePullRequestRequest.parse({ markdown }))
    }
  )
}

/**
 * Commit the change to a branch and get the provider's New-PR deep-link to
 * open in a new tab (review + open in the provider's own UI). Reuses the
 * pull-request request body (markdown).
 */
export function prepareGitReviewUrl(id: string, markdown: string): Promise<GitReviewUrlResult> {
  return request(
    `/api/docs/${encodeURIComponent(id)}/git/review-url`,
    (b) => GitReviewUrlResult.parse(b),
    {
      method: 'POST',
      body: JSON.stringify(CreatePullRequestRequest.parse({ markdown }))
    }
  )
}

export function putGitUserCredential(sourceId: string, token: string): Promise<void> {
  return request(`/api/git-sources/${encodeURIComponent(sourceId)}/credentials`, () => undefined, {
    method: 'PUT',
    body: JSON.stringify(GitSetCredentialRequest.parse({ token }))
  })
}

/**
 * Clear the caller's own stored git credential (PAT or OAuth tokens) for a
 * source. Needed before re-connecting under a corrected OAuth scope — the
 * oauth/start route refreshes an existing token (keeping its audience) rather
 * than re-authorizing, so a wrong-audience token must be deleted first.
 */
export function deleteGitUserCredential(sourceId: string): Promise<void> {
  return request(`/api/git-sources/${encodeURIComponent(sourceId)}/credentials`, () => undefined, {
    method: 'DELETE'
  })
}
