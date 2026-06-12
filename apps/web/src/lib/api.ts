import {
  AddEditorRequest,
  AddTeamMemberRequest,
  AttachDocRequest,
  AttachSkillRequest,
  ConfigResponse,
  CreateDocRequest,
  CreateProductRequest,
  CreateSkillRequest,
  CreateTeamRequest,
  DocContent,
  DocAttachmentRef,
  DocDetail,
  DocEditorsResponse,
  DocSummary,
  DocTags,
  FolderRenameRequest,
  FolderTreeResponse,
  HealthResponse,
  VersionResponse,
  SetLockedRequest,
  SkillAttachmentRef,
  SkillContentSaveResult,
  SkillDetail,
  SkillExportResponse,
  SkillRevisionSummary,
  SkillSummary,
  SkillTags,
  AdminUpstreamRow,
  AdminUserRow,
  Invite,
  JoinCode,
  CreateInvitesResponse,
  CreateJoinCodeResponse,
  AdminUsageResponse,
  AuditLogResponse,
  OAuthClientsResponse,
  OAuthClientsPruneResponse,
  UsageResponse,
  CreateUpstreamRequest,
  MeResponse,
  UpdateUserRoleRequest,
  PasteBearerRequest,
  ProductRef,
  RoleRef,
  AdminRoleRow,
  CreateRoleRequest,
  UpdateRoleRequest,
  SetUserRolesRequest,
  ReplaceToolAccessRequest,
  UpstreamToolAccessResponse,
  RefreshToolsResponse,
  ReplaceVisibilityRequest,
  UpdateSkillRequest,
  UpstreamToolsResponse,
  UpdateUpstreamRequest,
  RevisionSummary,
  RestoreRequest,
  SearchRequest,
  SearchResponse,
  AdminGitSourceRow,
  CreateGitSourceRequest,
  UpdateGitSourceRequest,
  GitSetCredentialRequest,
  GitOAuthConfigRequest,
  GitDocStatus,
  CreatePullRequestRequest,
  CreatePullRequestResult,
  GitReviewUrlResult,
  AdminTeamRow,
  TeamMemberRow,
  TeamProductsAssignment,
  TeamProductsPayload,
  TeamRef,
  UpdateDocRequest,
  UpdateProductRequest,
  UpdateTeamRequest,
  UserSearchResult,
  UserUpstreamSummary
} from '@ctxlayer/shared'
import type {
  AdminUpstreamRow as AdminUpstreamRowT,
  AdminUserRow as AdminUserRowT,
  Invite as InviteT,
  JoinCode as JoinCodeT,
  CreateInvitesResponse as CreateInvitesResponseT,
  CreateJoinCodeResponse as CreateJoinCodeResponseT,
  AdminUsageResponse as AdminUsageResponseT,
  AttachDocRequest as AttachDocRequestT,
  AttachSkillRequest as AttachSkillRequestT,
  AuditLogResponse as AuditLogResponseT,
  OAuthClientsResponse as OAuthClientsResponseT,
  OAuthClientsPruneResponse as OAuthClientsPruneResponseT,
  UsageResponse as UsageResponseT,
  UsageRange as UsageRangeT,
  CreateUpstreamRequest as CreateUpstreamRequestT,
  CreateSkillRequest as CreateSkillRequestT,
  RefreshToolsResponse as RefreshToolsResponseT,
  UpstreamToolsResponse as UpstreamToolsResponseT,
  ReplaceVisibilityRequest as ReplaceVisibilityRequestT,
  UpdateSkillRequest as UpdateSkillRequestT,
  UpdateUpstreamRequest as UpdateUpstreamRequestT,
  UpdateUserRoleRequest as UpdateUserRoleRequestT,
  AddEditorRequest as AddEditorRequestT,
  AddTeamMemberRequest as AddTeamMemberRequestT,
  ConfigResponse as ConfigResponseT,
  CreateDocRequest as CreateDocRequestT,
  CreateProductRequest as CreateProductRequestT,
  CreateTeamRequest as CreateTeamRequestT,
  DocAttachmentRef as DocAttachmentRefT,
  DocContent as DocContentT,
  DocDetail as DocDetailT,
  DocEditorsResponse as DocEditorsResponseT,
  DocSummary as DocSummaryT,
  DocTags as DocTagsT,
  FolderRenameRequest as FolderRenameRequestT,
  FolderTreeResponse as FolderTreeResponseT,
  HealthResponse as HealthResponseT,
  VersionResponse as VersionResponseT,
  SetLockedRequest as SetLockedRequestT,
  SkillAttachmentRef as SkillAttachmentRefT,
  SkillContentSaveResult as SkillContentSaveResultT,
  SkillDetail as SkillDetailT,
  SkillExportResponse as SkillExportResponseT,
  SkillRevisionSummary as SkillRevisionSummaryT,
  SkillSummary as SkillSummaryT,
  SkillTags as SkillTagsT,
  MeResponse as MeResponseT,
  PasteBearerRequest as PasteBearerRequestT,
  ProductRef as ProductRefT,
  RoleRef as RoleRefT,
  AdminRoleRow as AdminRoleRowT,
  CreateRoleRequest as CreateRoleRequestT,
  UpdateRoleRequest as UpdateRoleRequestT,
  UpstreamToolAccessResponse as UpstreamToolAccessResponseT,
  ToolAccessRule as ToolAccessRuleT,
  RevisionSummary as RevisionSummaryT,
  RestoreRequest as RestoreRequestT,
  SearchRequest as SearchRequestT,
  SearchResponse as SearchResponseT,
  AdminGitSourceRow as AdminGitSourceRowT,
  CreateGitSourceRequest as CreateGitSourceRequestT,
  UpdateGitSourceRequest as UpdateGitSourceRequestT,
  GitOAuthConfigRequest as GitOAuthConfigRequestT,
  GitDocStatus as GitDocStatusT,
  CreatePullRequestResult as CreatePullRequestResultT,
  GitReviewUrlResult as GitReviewUrlResultT,
  AdminTeamRow as AdminTeamRowT,
  TeamMemberRow as TeamMemberRowT,
  TeamProductsAssignment as TeamProductsAssignmentT,
  TeamRef as TeamRefT,
  UpdateDocRequest as UpdateDocRequestT,
  UpdateProductRequest as UpdateProductRequestT,
  UpdateTeamRequest as UpdateTeamRequestT,
  UserSearchResult as UserSearchResultT,
  UserUpstreamSummary as UserUpstreamSummaryT
} from '@ctxlayer/shared'
import { readCsrfToken } from './csrf'
import { z } from 'zod'

/** HTTP-level failure (non-2xx). */
export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown
  ) {
    super(`api ${status}`)
  }
}

/** Server returned 2xx but the body didn't match the expected schema. */
export class ApiSchemaError extends Error {
  constructor(
    public path: string,
    cause: unknown
  ) {
    super(`api schema mismatch at ${path}`, { cause })
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Single fetch entry-point. Adds `credentials:'include'` so cookies
 * ride along, attaches `X-CSRF` on unsafe methods (cookie value echoed
 * — see apps/worker/src/auth/csrf.ts), and routes the response through
 * the caller's schema parser.
 */
async function request<T>(
  path: string,
  parse: (raw: unknown) => T,
  init: RequestInit & { method?: string } = {}
): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase()
  const headers = new Headers(init.headers)
  if (!SAFE_METHODS.has(method)) {
    const token = readCsrfToken()
    if (token) headers.set('X-CSRF', token)
    if (init.body && !headers.has('content-type')) {
      headers.set('content-type', 'application/json')
    }
  }
  const res = await fetch(path, { credentials: 'include', ...init, method, headers })
  // 204 No Content shortcut — the parser is called with `undefined`
  // and most callers pass `() => undefined` to satisfy void.
  if (res.status === 204) {
    try {
      return parse(undefined)
    } catch (cause) {
      throw new ApiSchemaError(path, cause)
    }
  }
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new ApiError(res.status, body)
  try {
    return parse(body)
  } catch (cause) {
    throw new ApiSchemaError(path, cause)
  }
}

// ----- session-shaped reads ----------------------------------------------

export function fetchMe(signal?: AbortSignal): Promise<MeResponseT> {
  return request('/api/me', (b) => MeResponse.parse(b), { signal })
}

export function fetchHealth(signal?: AbortSignal): Promise<HealthResponseT> {
  return request('/api/health', (b) => HealthResponse.parse(b), { signal })
}

export function fetchConfig(signal?: AbortSignal): Promise<ConfigResponseT> {
  return request('/api/config', (b) => ConfigResponse.parse(b), { signal })
}

// Build provenance for the footer version stamp. `gitSha`/`builtAt` are
// injected at deploy time by scripts/deploy.mjs (empty in local dev).
export function fetchVersion(signal?: AbortSignal): Promise<VersionResponseT> {
  return request('/api/version', (b) => VersionResponse.parse(b), { signal })
}

export function signOut(): Promise<void> {
  return request('/api/auth/signout', () => undefined, { method: 'POST' })
}

// ----- docs CRUD ----------------------------------------------------------

const DocList = z.array(DocSummary)
const CreateDocResult = z.object({ id: z.string(), slug: z.string() })
const PutContentResult = z.object({
  revisionId: z.string(),
  byteSize: z.number(),
  contentHash: z.string()
})
const RestoreResult = z.object({ revisionId: z.string() })
const RevisionList = z.array(RevisionSummary)

export function fetchDocs(signal?: AbortSignal): Promise<DocSummaryT[]> {
  return request('/api/docs', (b) => DocList.parse(b), { signal })
}

// Admin: rebuild the search index for every doc (after a chunking /
// embedding change). Returns how many reindex jobs were enqueued.
const ReindexResult = z.object({ queued: z.number(), total: z.number() })
export function adminReindexAllDocs(): Promise<{ queued: number; total: number }> {
  return request('/api/admin/docs/reindex', (b) => ReindexResult.parse(b), { method: 'POST' })
}

// Semantic RAG search over the doc library. POST so the query + scope
// ride in the body (and to match the worker's CSRF-gated route).
export function searchDocs(req: SearchRequestT, signal?: AbortSignal): Promise<SearchResponseT> {
  return request('/api/search', (b) => SearchResponse.parse(b), {
    method: 'POST',
    body: JSON.stringify(SearchRequest.parse(req)),
    signal
  })
}

// ----- admin: git sources -------------------------------------------------

const AdminGitSourceList = z.array(AdminGitSourceRow)
const gitSourcePath = (id: string) => `/api/admin/git-sources/${encodeURIComponent(id)}`

export function fetchAdminGitSources(signal?: AbortSignal): Promise<AdminGitSourceRowT[]> {
  return request('/api/admin/git-sources', (b) => AdminGitSourceList.parse(b), { signal })
}

export function fetchAdminGitSource(id: string, signal?: AbortSignal): Promise<AdminGitSourceRowT> {
  return request(gitSourcePath(id), (b) => AdminGitSourceRow.parse(b), { signal })
}

export function adminCreateGitSource(input: CreateGitSourceRequestT): Promise<AdminGitSourceRowT> {
  return request('/api/admin/git-sources', (b) => AdminGitSourceRow.parse(b), {
    method: 'POST',
    body: JSON.stringify(CreateGitSourceRequest.parse(input))
  })
}

export function adminPatchGitSource(id: string, patch: UpdateGitSourceRequestT): Promise<void> {
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
  payload: ReplaceVisibilityRequestT
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

export function adminPutGitSourceOAuth(id: string, body: GitOAuthConfigRequestT): Promise<void> {
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
export function fetchDocGitStatus(id: string, signal?: AbortSignal): Promise<GitDocStatusT> {
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
): Promise<CreatePullRequestResultT> {
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
export function prepareGitReviewUrl(id: string, markdown: string): Promise<GitReviewUrlResultT> {
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

export function deleteGitUserCredential(sourceId: string): Promise<void> {
  return request(`/api/git-sources/${encodeURIComponent(sourceId)}/credentials`, () => undefined, {
    method: 'DELETE'
  })
}

export function createDoc(input: CreateDocRequestT): Promise<{ id: string; slug: string }> {
  return request('/api/docs', (b) => CreateDocResult.parse(b), {
    method: 'POST',
    body: JSON.stringify(CreateDocRequest.parse(input))
  })
}

export function fetchDoc(id: string, signal?: AbortSignal): Promise<DocDetailT> {
  return request(`/api/docs/${encodeURIComponent(id)}`, (b) => DocDetail.parse(b), { signal })
}

export function patchDoc(id: string, patch: UpdateDocRequestT): Promise<void> {
  return request(`/api/docs/${encodeURIComponent(id)}`, () => undefined, {
    method: 'PATCH',
    body: JSON.stringify(UpdateDocRequest.parse(patch))
  })
}

export function deleteDoc(id: string): Promise<void> {
  return request(`/api/docs/${encodeURIComponent(id)}`, () => undefined, { method: 'DELETE' })
}

export function fetchDocContent(id: string, signal?: AbortSignal): Promise<DocContentT> {
  return request(`/api/docs/${encodeURIComponent(id)}/content`, (b) => DocContent.parse(b), {
    signal
  })
}

// `explicit` distinguishes a user Save (cuts a distinct revision) from a
// background autosave (coalesces into the rolling autosave revision —
// `?mode=autosave`). Default is explicit so any caller that doesn't opt in
// (e.g. doc import) keeps the old "every save is a checkpoint" behaviour.
// `signal` lets callers attach a timeout (AbortSignal.timeout) so a hung
// request can't wedge the autosave's in-flight guard indefinitely.
export function putDocContent(
  id: string,
  content: DocContentT,
  opts: { explicit?: boolean; signal?: AbortSignal } = {}
): Promise<{ revisionId: string; byteSize: number; contentHash: string }> {
  const qs = opts.explicit === false ? '?mode=autosave' : ''
  return request(
    `/api/docs/${encodeURIComponent(id)}/content${qs}`,
    (b) => PutContentResult.parse(b),
    {
      method: 'PUT',
      body: JSON.stringify(DocContent.parse(content)),
      signal: opts.signal
    }
  )
}

export function fetchRevisions(id: string, signal?: AbortSignal): Promise<RevisionSummaryT[]> {
  return request(`/api/docs/${encodeURIComponent(id)}/revisions`, (b) => RevisionList.parse(b), {
    signal
  })
}

export function restoreRevision(
  id: string,
  body: RestoreRequestT
): Promise<{ revisionId: string }> {
  return request(`/api/docs/${encodeURIComponent(id)}/restore`, (b) => RestoreResult.parse(b), {
    method: 'POST',
    body: JSON.stringify(RestoreRequest.parse(body))
  })
}

export function fetchRevisionContent(
  id: string,
  revisionId: string,
  signal?: AbortSignal
): Promise<DocContentT> {
  return request(
    `/api/docs/${encodeURIComponent(id)}/revisions/${encodeURIComponent(revisionId)}/content`,
    (b) => DocContent.parse(b),
    { signal }
  )
}

// ----- lock toggle --------------------------------------------------------

export function setDocLocked(id: string, body: SetLockedRequestT): Promise<void> {
  return request(`/api/docs/${encodeURIComponent(id)}/lock`, () => undefined, {
    method: 'PUT',
    body: JSON.stringify(SetLockedRequest.parse(body))
  })
}

// ----- folders ------------------------------------------------------------

const FolderTreeResponseSchema = FolderTreeResponse

export function fetchFolders(signal?: AbortSignal): Promise<FolderTreeResponseT> {
  return request('/api/folders', (b) => FolderTreeResponseSchema.parse(b), { signal })
}

export function renameFolder(
  body: FolderRenameRequestT
): Promise<{ moved: number; ids: string[] }> {
  return request(
    '/api/folders',
    (b) => z.object({ moved: z.number(), ids: z.array(z.string()) }).parse(b),
    {
      method: 'PATCH',
      body: JSON.stringify(FolderRenameRequest.parse(body))
    }
  )
}

export function deleteFolder(path: string): Promise<void> {
  // The backend takes a base64url-encoded path so the leading "/"
  // doesn't tangle with route parsing.
  const enc = base64UrlEncode(path)
  return request(`/api/folders/${enc}`, () => undefined, { method: 'DELETE' })
}

function base64UrlEncode(s: string): string {
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// ----- per-doc ACL --------------------------------------------------------

export function fetchDocEditors(id: string, signal?: AbortSignal): Promise<DocEditorsResponseT> {
  return request(
    `/api/docs/${encodeURIComponent(id)}/editors`,
    (b) => DocEditorsResponse.parse(b),
    {
      signal
    }
  )
}

export function addDocEditor(id: string, body: AddEditorRequestT): Promise<void> {
  return request(`/api/docs/${encodeURIComponent(id)}/editors`, () => undefined, {
    method: 'POST',
    body: JSON.stringify(AddEditorRequest.parse(body))
  })
}

export function removeDocEditor(
  id: string,
  scope: 'user' | 'everyone',
  scopeId: string
): Promise<void> {
  const base = `/api/docs/${encodeURIComponent(id)}/editors`
  // 'everyone' is a singleton on a doc — the server route has no
  // :scopeId segment for it. 'user' carries the userId in the path.
  const path =
    scope === 'everyone' ? `${base}/everyone` : `${base}/user/${encodeURIComponent(scopeId)}`
  return request(path, () => undefined, { method: 'DELETE' })
}

// ----- user directory -----------------------------------------------------

export function searchUsers(emailPrefix: string, signal?: AbortSignal): Promise<UserSearchResultT> {
  const qs = new URLSearchParams({ email: emailPrefix })
  return request(`/api/users?${qs}`, (b) => UserSearchResult.parse(b), { signal })
}

// ----- doc tags -----------------------------------------------------------

export function fetchDocTags(id: string, signal?: AbortSignal): Promise<DocTagsT> {
  return request(`/api/docs/${encodeURIComponent(id)}/tags`, (b) => DocTags.parse(b), { signal })
}

export function putDocTags(id: string, tags: DocTagsT): Promise<void> {
  return request(`/api/docs/${encodeURIComponent(id)}/tags`, () => undefined, {
    method: 'PUT',
    body: JSON.stringify(DocTags.parse(tags))
  })
}

// ----- teams + products (public-read) ------------------------------------

const TeamList = z.array(TeamRef)
const ProductList = z.array(ProductRef)
const RoleList = z.array(RoleRef)
const TeamMemberList = z.array(TeamMemberRow)
const TeamProductsList = z.array(TeamProductsAssignment)

export function fetchTeams(signal?: AbortSignal): Promise<TeamRefT[]> {
  return request('/api/teams', (b) => TeamList.parse(b), { signal })
}

export function fetchProducts(signal?: AbortSignal): Promise<ProductRefT[]> {
  return request('/api/products', (b) => ProductList.parse(b), { signal })
}

export function fetchRoles(signal?: AbortSignal): Promise<RoleRefT[]> {
  return request('/api/roles', (b) => RoleList.parse(b), { signal })
}

// ----- admin teams --------------------------------------------------------

const AdminTeamList = z.array(AdminTeamRow)

export function fetchAdminTeams(signal?: AbortSignal): Promise<AdminTeamRowT[]> {
  return request('/api/admin/teams', (b) => AdminTeamList.parse(b), { signal })
}

export function adminCreateTeam(input: CreateTeamRequestT): Promise<AdminTeamRowT> {
  return request('/api/admin/teams', (b) => AdminTeamRow.parse(b), {
    method: 'POST',
    body: JSON.stringify(CreateTeamRequest.parse(input))
  })
}

export function adminPatchTeam(id: string, patch: UpdateTeamRequestT): Promise<void> {
  return request(`/api/admin/teams/${encodeURIComponent(id)}`, () => undefined, {
    method: 'PATCH',
    body: JSON.stringify(UpdateTeamRequest.parse(patch))
  })
}

export function adminDeleteTeam(id: string): Promise<void> {
  return request(`/api/admin/teams/${encodeURIComponent(id)}`, () => undefined, {
    method: 'DELETE'
  })
}

export function fetchTeamMembers(id: string, signal?: AbortSignal): Promise<TeamMemberRowT[]> {
  return request(
    `/api/admin/teams/${encodeURIComponent(id)}/members`,
    (b) => TeamMemberList.parse(b),
    { signal }
  )
}

export function addTeamMember(teamId: string, body: AddTeamMemberRequestT): Promise<void> {
  return request(`/api/admin/teams/${encodeURIComponent(teamId)}/members`, () => undefined, {
    method: 'POST',
    body: JSON.stringify(AddTeamMemberRequest.parse(body))
  })
}

export function removeTeamMember(teamId: string, userId: string): Promise<void> {
  const path = `/api/admin/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}`
  return request(path, () => undefined, { method: 'DELETE' })
}

// ----- admin roles --------------------------------------------------------

const AdminRoleList = z.array(AdminRoleRow)

export function fetchAdminRoles(signal?: AbortSignal): Promise<AdminRoleRowT[]> {
  return request('/api/admin/roles', (b) => AdminRoleList.parse(b), { signal })
}

export function adminCreateRole(input: CreateRoleRequestT): Promise<RoleRefT> {
  return request('/api/admin/roles', (b) => RoleRef.parse(b), {
    method: 'POST',
    body: JSON.stringify(CreateRoleRequest.parse(input))
  })
}

export function adminPatchRole(id: string, patch: UpdateRoleRequestT): Promise<void> {
  return request(`/api/admin/roles/${encodeURIComponent(id)}`, () => undefined, {
    method: 'PATCH',
    body: JSON.stringify(UpdateRoleRequest.parse(patch))
  })
}

export function adminDeleteRole(id: string): Promise<void> {
  return request(`/api/admin/roles/${encodeURIComponent(id)}`, () => undefined, { method: 'DELETE' })
}

export function putUserRoles(userId: string, roleIds: string[]): Promise<void> {
  return request(`/api/admin/users/${encodeURIComponent(userId)}/roles`, () => undefined, {
    method: 'PUT',
    body: JSON.stringify(SetUserRolesRequest.parse({ roleIds }))
  })
}

// ----- admin products + team↔product matrix ------------------------------

export function adminCreateProduct(input: CreateProductRequestT): Promise<ProductRefT> {
  return request('/api/admin/products', (b) => ProductRef.parse(b), {
    method: 'POST',
    body: JSON.stringify(CreateProductRequest.parse(input))
  })
}

export function adminPatchProduct(id: string, patch: UpdateProductRequestT): Promise<void> {
  return request(`/api/admin/products/${encodeURIComponent(id)}`, () => undefined, {
    method: 'PATCH',
    body: JSON.stringify(UpdateProductRequest.parse(patch))
  })
}

export function adminDeleteProduct(id: string): Promise<void> {
  return request(`/api/admin/products/${encodeURIComponent(id)}`, () => undefined, {
    method: 'DELETE'
  })
}

export function fetchTeamProducts(signal?: AbortSignal): Promise<TeamProductsAssignmentT[]> {
  return request('/api/admin/team-products', (b) => TeamProductsList.parse(b), { signal })
}

export function putTeamProducts(rules: TeamProductsAssignmentT[]): Promise<void> {
  return request('/api/admin/team-products', () => undefined, {
    method: 'PUT',
    body: JSON.stringify(TeamProductsPayload.parse({ rules }))
  })
}

// ----- admin upstreams ----------------------------------------------------

const AdminUpstreamList = z.array(AdminUpstreamRow)

export function fetchAdminUpstreams(signal?: AbortSignal): Promise<AdminUpstreamRowT[]> {
  return request('/api/admin/upstreams', (b) => AdminUpstreamList.parse(b), { signal })
}

export function fetchAdminUpstream(id: string, signal?: AbortSignal): Promise<AdminUpstreamRowT> {
  return request(
    `/api/admin/upstreams/${encodeURIComponent(id)}`,
    (b) => AdminUpstreamRow.parse(b),
    { signal }
  )
}

export function adminCreateUpstream(input: CreateUpstreamRequestT): Promise<AdminUpstreamRowT> {
  return request('/api/admin/upstreams', (b) => AdminUpstreamRow.parse(b), {
    method: 'POST',
    body: JSON.stringify(CreateUpstreamRequest.parse(input))
  })
}

export function adminPatchUpstream(id: string, patch: UpdateUpstreamRequestT): Promise<void> {
  return request(`/api/admin/upstreams/${encodeURIComponent(id)}`, () => undefined, {
    method: 'PATCH',
    body: JSON.stringify(UpdateUpstreamRequest.parse(patch))
  })
}

export function adminDeleteUpstream(id: string): Promise<void> {
  return request(`/api/admin/upstreams/${encodeURIComponent(id)}`, () => undefined, {
    method: 'DELETE'
  })
}

export function adminPutUpstreamVisibility(
  id: string,
  body: ReplaceVisibilityRequestT
): Promise<void> {
  return request(`/api/admin/upstreams/${encodeURIComponent(id)}/visibility`, () => undefined, {
    method: 'PUT',
    body: JSON.stringify(ReplaceVisibilityRequest.parse(body))
  })
}

export function adminRefreshUpstreamTools(id: string): Promise<RefreshToolsResponseT> {
  return request(
    `/api/admin/upstreams/${encodeURIComponent(id)}/refresh-tools`,
    (b) => RefreshToolsResponse.parse(b),
    { method: 'POST' }
  )
}

export function fetchAdminUpstreamTools(
  id: string,
  signal?: AbortSignal
): Promise<UpstreamToolsResponseT> {
  return request(
    `/api/admin/upstreams/${encodeURIComponent(id)}/tools`,
    (b) => UpstreamToolsResponse.parse(b),
    { signal }
  )
}

export function fetchUpstreamToolAccess(
  id: string,
  signal?: AbortSignal
): Promise<UpstreamToolAccessResponseT> {
  return request(
    `/api/admin/upstreams/${encodeURIComponent(id)}/tool-access`,
    (b) => UpstreamToolAccessResponse.parse(b),
    { signal }
  )
}

export function putUpstreamToolAccess(
  id: string,
  toolName: string,
  rules: ToolAccessRuleT[]
): Promise<void> {
  return request(`/api/admin/upstreams/${encodeURIComponent(id)}/tool-access`, () => undefined, {
    method: 'PUT',
    body: JSON.stringify(ReplaceToolAccessRequest.parse({ toolName, rules }))
  })
}

export function adminPutSharedCredentials(id: string, body: PasteBearerRequestT): Promise<void> {
  return request(
    `/api/admin/upstreams/${encodeURIComponent(id)}/shared-credentials`,
    () => undefined,
    {
      method: 'PUT',
      body: JSON.stringify(PasteBearerRequest.parse(body))
    }
  )
}

export function adminDeleteSharedCredentials(id: string): Promise<void> {
  return request(
    `/api/admin/upstreams/${encodeURIComponent(id)}/shared-credentials`,
    () => undefined,
    { method: 'DELETE' }
  )
}

// ----- admin users --------------------------------------------------------

const AdminUserList = z.array(AdminUserRow)
const RevokeCredsResult = z.object({ removed: z.number().int().min(0) })

export function fetchAdminUsers(signal?: AbortSignal): Promise<AdminUserRowT[]> {
  return request('/api/admin/users', (b) => AdminUserList.parse(b), { signal })
}

export function adminPatchUserRole(userId: string, body: UpdateUserRoleRequestT): Promise<void> {
  return request(`/api/admin/users/${encodeURIComponent(userId)}`, () => undefined, {
    method: 'PATCH',
    body: JSON.stringify(UpdateUserRoleRequest.parse(body))
  })
}

// ----- usage --------------------------------------------------------------

// Browser UTC offset, minutes east of UTC (getTimezoneOffset uses the inverse
// sign). Sent as `tz` so the day window + chart follow the viewer's calendar.
function browserTzOffsetMin(): number {
  return -new Date().getTimezoneOffset()
}

export interface FetchUsageOpts {
  range?: UsageRangeT
}

export function fetchUsage(
  opts: FetchUsageOpts = {},
  signal?: AbortSignal
): Promise<UsageResponseT> {
  const params = new URLSearchParams()
  if (opts.range) params.set('range', opts.range)
  params.set('tz', String(browserTzOffsetMin()))
  const qs = params.toString()
  const path = qs ? `/api/usage?${qs}` : '/api/usage'
  return request(path, (b) => UsageResponse.parse(b), { signal })
}

export interface FetchAdminUsageOpts extends FetchUsageOpts {
  userId?: string
  upstreamId?: string
}

export function fetchAdminUsage(
  opts: FetchAdminUsageOpts = {},
  signal?: AbortSignal
): Promise<AdminUsageResponseT> {
  const params = new URLSearchParams()
  if (opts.range) params.set('range', opts.range)
  params.set('tz', String(browserTzOffsetMin()))
  if (opts.userId) params.set('userId', opts.userId)
  if (opts.upstreamId) params.set('upstreamId', opts.upstreamId)
  const qs = params.toString()
  const path = qs ? `/api/admin/usage?${qs}` : '/api/admin/usage'
  return request(path, (b) => AdminUsageResponse.parse(b), { signal })
}

// ----- admin oauth clients ------------------------------------------------

export interface FetchAdminOAuthClientsOpts {
  cursor?: string
  limit?: number
}

export function fetchAdminOAuthClients(
  opts: FetchAdminOAuthClientsOpts = {},
  signal?: AbortSignal
): Promise<OAuthClientsResponseT> {
  const params = new URLSearchParams()
  if (opts.cursor) params.set('cursor', opts.cursor)
  if (opts.limit) params.set('limit', String(opts.limit))
  const qs = params.toString()
  const path = qs ? `/api/admin/oauth-clients?${qs}` : '/api/admin/oauth-clients'
  return request(path, (b) => OAuthClientsResponse.parse(b), { signal })
}

export function pruneAdminOAuthClients(): Promise<OAuthClientsPruneResponseT> {
  return request('/api/admin/oauth-clients/prune', (b) => OAuthClientsPruneResponse.parse(b), {
    method: 'POST'
  })
}

// ----- admin audit --------------------------------------------------------

export interface FetchAdminAuditOpts {
  before?: number
  action?: string
  actorId?: string
  limit?: number
}

export function fetchAdminAudit(
  opts: FetchAdminAuditOpts = {},
  signal?: AbortSignal
): Promise<AuditLogResponseT> {
  const params = new URLSearchParams()
  if (opts.before !== undefined) params.set('before', String(opts.before))
  if (opts.action) params.set('action', opts.action)
  if (opts.actorId) params.set('actorId', opts.actorId)
  if (opts.limit) params.set('limit', String(opts.limit))
  const qs = params.toString()
  const path = qs ? `/api/admin/audit?${qs}` : '/api/admin/audit'
  return request(path, (b) => AuditLogResponse.parse(b), { signal })
}

export function adminRevokeUserCredentials(userId: string): Promise<{ removed: number }> {
  return request(
    `/api/admin/users/${encodeURIComponent(userId)}/credentials`,
    (b) => RevokeCredsResult.parse(b),
    { method: 'DELETE' }
  )
}

// ----- user lifecycle (plan L) --------------------------------------------

const DeleteUserResult = z.object({ reassignedSkills: z.number() })
const SuspendResult = z.object({ revokedGrants: z.number() })

export function adminSuspendUser(userId: string): Promise<{ revokedGrants: number }> {
  return request(`/api/admin/users/${encodeURIComponent(userId)}/suspend`, (b) => SuspendResult.parse(b), {
    method: 'POST'
  })
}

// Reactivate doubles as "approve" for a pending user (both → active).
export function adminReactivateUser(userId: string): Promise<void> {
  return request(`/api/admin/users/${encodeURIComponent(userId)}/reactivate`, () => undefined, {
    method: 'POST'
  })
}

export function adminRejectUser(userId: string): Promise<void> {
  return request(`/api/admin/users/${encodeURIComponent(userId)}/reject`, () => undefined, {
    method: 'POST'
  })
}

export function adminDeleteUser(userId: string): Promise<{ reassignedSkills: number }> {
  return request(`/api/admin/users/${encodeURIComponent(userId)}`, (b) => DeleteUserResult.parse(b), {
    method: 'DELETE'
  })
}

// ----- invites ------------------------------------------------------------

const InviteList = z.array(Invite)

export function fetchInvites(signal?: AbortSignal): Promise<InviteT[]> {
  return request('/api/admin/invites', (b) => InviteList.parse(b), { signal })
}

export function adminCreateInvites(emails: string): Promise<CreateInvitesResponseT> {
  return request('/api/admin/invites', (b) => CreateInvitesResponse.parse(b), {
    method: 'POST',
    body: JSON.stringify({ emails })
  })
}

export function adminDeleteInvite(id: string): Promise<void> {
  return request(`/api/admin/invites/${encodeURIComponent(id)}`, () => undefined, {
    method: 'DELETE'
  })
}

// ----- join codes ---------------------------------------------------------

const JoinCodeList = z.array(JoinCode)

export function fetchJoinCodes(signal?: AbortSignal): Promise<JoinCodeT[]> {
  return request('/api/admin/join-codes', (b) => JoinCodeList.parse(b), { signal })
}

export interface CreateJoinCodeInput {
  label?: string
  domainRestrict?: string | null
  onRedeem: 'active' | 'pending'
  maxUses?: number | null
  expiresInDays?: number | null
}

export function adminCreateJoinCode(input: CreateJoinCodeInput): Promise<CreateJoinCodeResponseT> {
  return request('/api/admin/join-codes', (b) => CreateJoinCodeResponse.parse(b), {
    method: 'POST',
    body: JSON.stringify(input)
  })
}

export function adminRevokeJoinCode(id: string): Promise<void> {
  return request(`/api/admin/join-codes/${encodeURIComponent(id)}`, () => undefined, {
    method: 'DELETE'
  })
}

// ----- upstreams (user-facing) --------------------------------------------

const UserUpstreamList = z.array(UserUpstreamSummary)

export function fetchUpstreams(signal?: AbortSignal): Promise<UserUpstreamSummaryT[]> {
  return request('/api/upstreams', (b) => UserUpstreamList.parse(b), { signal })
}

export function fetchUserUpstreamTools(
  id: string,
  signal?: AbortSignal
): Promise<UpstreamToolsResponseT> {
  return request(
    `/api/upstreams/${encodeURIComponent(id)}/tools`,
    (b) => UpstreamToolsResponse.parse(b),
    { signal }
  )
}

export function putUpstreamCredentials(
  upstreamId: string,
  body: PasteBearerRequestT
): Promise<void> {
  return request(`/api/upstreams/${encodeURIComponent(upstreamId)}/credentials`, () => undefined, {
    method: 'PUT',
    body: JSON.stringify(PasteBearerRequest.parse(body))
  })
}

export function deleteUpstreamCredentials(upstreamId: string): Promise<void> {
  return request(`/api/upstreams/${encodeURIComponent(upstreamId)}/credentials`, () => undefined, {
    method: 'DELETE'
  })
}

// ----- skills (M7a) -------------------------------------------------------

const SkillList = z.array(SkillSummary)
const CreateSkillResult = z.object({ id: z.string(), slug: z.string() })
const SkillRevisionList = z.array(SkillRevisionSummary)
const SkillAttachmentList = z.array(SkillAttachmentRef)
const DocAttachmentList = z.array(DocAttachmentRef)

export interface FetchSkillsOpts {
  status?: 'draft' | 'published' | 'archived' | 'all'
}

export function fetchSkills(
  opts: FetchSkillsOpts = {},
  signal?: AbortSignal
): Promise<SkillSummaryT[]> {
  const qs = opts.status ? `?status=${encodeURIComponent(opts.status)}` : ''
  return request(`/api/skills${qs}`, (b) => SkillList.parse(b), { signal })
}

export function fetchSkill(id: string, signal?: AbortSignal): Promise<SkillDetailT> {
  return request(`/api/skills/${encodeURIComponent(id)}`, (b) => SkillDetail.parse(b), {
    signal
  })
}

export function createSkill(input: CreateSkillRequestT): Promise<{ id: string; slug: string }> {
  return request('/api/skills', (b) => CreateSkillResult.parse(b), {
    method: 'POST',
    body: JSON.stringify(CreateSkillRequest.parse(input))
  })
}

export function patchSkill(id: string, patch: UpdateSkillRequestT): Promise<void> {
  return request(`/api/skills/${encodeURIComponent(id)}`, () => undefined, {
    method: 'PATCH',
    body: JSON.stringify(UpdateSkillRequest.parse(patch))
  })
}

export function deleteSkill(id: string): Promise<void> {
  return request(`/api/skills/${encodeURIComponent(id)}`, () => undefined, { method: 'DELETE' })
}

export function fetchSkillContent(id: string, signal?: AbortSignal): Promise<DocContentT> {
  return request(`/api/skills/${encodeURIComponent(id)}/content`, (b) => DocContent.parse(b), {
    signal
  })
}

// See putDocContent: `explicit: false` opts a background autosave into
// coalescing (`?mode=autosave`); the default cuts a distinct revision.
export function putSkillContent(
  id: string,
  content: DocContentT,
  opts: { explicit?: boolean; signal?: AbortSignal } = {}
): Promise<SkillContentSaveResultT> {
  const qs = opts.explicit === false ? '?mode=autosave' : ''
  return request(
    `/api/skills/${encodeURIComponent(id)}/content${qs}`,
    (b) => SkillContentSaveResult.parse(b),
    {
      method: 'PUT',
      body: JSON.stringify(DocContent.parse(content)),
      signal: opts.signal
    }
  )
}

export function fetchSkillRevisions(
  id: string,
  signal?: AbortSignal
): Promise<SkillRevisionSummaryT[]> {
  return request(
    `/api/skills/${encodeURIComponent(id)}/revisions`,
    (b) => SkillRevisionList.parse(b),
    { signal }
  )
}

export function restoreSkillRevision(
  id: string,
  body: RestoreRequestT
): Promise<{ revisionId: string }> {
  return request(`/api/skills/${encodeURIComponent(id)}/restore`, (b) => RestoreResult.parse(b), {
    method: 'POST',
    body: JSON.stringify(RestoreRequest.parse(body))
  })
}

export function fetchSkillRevisionContent(
  id: string,
  revisionId: string,
  signal?: AbortSignal
): Promise<DocContentT> {
  return request(
    `/api/skills/${encodeURIComponent(id)}/revisions/${encodeURIComponent(revisionId)}/content`,
    (b) => DocContent.parse(b),
    { signal }
  )
}

export function fetchSkillTags(id: string, signal?: AbortSignal): Promise<SkillTagsT> {
  return request(`/api/skills/${encodeURIComponent(id)}/tags`, (b) => SkillTags.parse(b), {
    signal
  })
}

export function putSkillTags(id: string, tags: SkillTagsT): Promise<void> {
  return request(`/api/skills/${encodeURIComponent(id)}/tags`, () => undefined, {
    method: 'PUT',
    body: JSON.stringify(SkillTags.parse(tags))
  })
}

// ----- attachments (M7a) --------------------------------------------------

export function fetchSkillAttachments(
  skillId: string,
  signal?: AbortSignal
): Promise<SkillAttachmentRefT[]> {
  const qs = new URLSearchParams({ skillId })
  return request(`/api/skill-attachments?${qs}`, (b) => SkillAttachmentList.parse(b), {
    signal
  })
}

export function attachSkill(input: AttachSkillRequestT): Promise<void> {
  return request('/api/skill-attachments', () => undefined, {
    method: 'POST',
    body: JSON.stringify(AttachSkillRequest.parse(input))
  })
}

export function detachSkill(input: AttachSkillRequestT): Promise<void> {
  return request('/api/skill-attachments', () => undefined, {
    method: 'DELETE',
    body: JSON.stringify(AttachSkillRequest.parse(input))
  })
}

export function fetchDocAttachments(
  docId: string,
  signal?: AbortSignal
): Promise<DocAttachmentRefT[]> {
  const qs = new URLSearchParams({ docId })
  return request(`/api/doc-attachments?${qs}`, (b) => DocAttachmentList.parse(b), {
    signal
  })
}

export function attachDoc(input: AttachDocRequestT): Promise<void> {
  return request('/api/doc-attachments', () => undefined, {
    method: 'POST',
    body: JSON.stringify(AttachDocRequest.parse(input))
  })
}

export function detachDoc(input: AttachDocRequestT): Promise<void> {
  return request('/api/doc-attachments', () => undefined, {
    method: 'DELETE',
    body: JSON.stringify(AttachDocRequest.parse(input))
  })
}

// CLI-only typically; the SPA might surface this for "preview the
// SKILL.md the CLI will write". Available for both roles since it's
// just a transformation of published skills.
export function fetchSkillsExport(signal?: AbortSignal): Promise<SkillExportResponseT> {
  return request('/api/skills/export', (b) => SkillExportResponse.parse(b), { signal })
}
