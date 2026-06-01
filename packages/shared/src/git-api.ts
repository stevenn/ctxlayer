import { z } from 'zod'
import { FolderPath } from './docs-types'
import { VisibilityRulePayload } from './upstream-api'
import { prefixedSlug } from './slug'

// ----- enums -------------------------------------------------------------

export const GitProvider = z.enum(['github', 'gitlab', 'azure'])
export type GitProvider = z.infer<typeof GitProvider>

export const GitCredStrategy = z.enum(['shared_bearer', 'user_bearer', 'user_oauth'])
export type GitCredStrategy = z.infer<typeof GitCredStrategy>

export const GitSyncInterval = z.enum(['hourly', '6x_daily', '2x_daily', 'daily', 'weekly'])
export type GitSyncInterval = z.infer<typeof GitSyncInterval>

export const GitSyncStatus = z.enum(['ok', 'partial', 'error'])
export type GitSyncStatus = z.infer<typeof GitSyncStatus>

export const GitSyncState = z.enum(['clean', 'local_edits', 'pr_open', 'conflict'])
export type GitSyncState = z.infer<typeof GitSyncState>

export const GitPrState = z.enum(['open', 'merged', 'closed', 'error'])
export type GitPrState = z.infer<typeof GitPrState>

// ----- field shapes ------------------------------------------------------

export const GitSourceSlug = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'lowercase, digits and dashes only')

// Folder root: '' (repo mirrored at the doc-store root) or a FolderPath.
export const GitFolderRoot = z.union([z.literal(''), FolderPath])

// Base URL trust boundary — mirrors UpstreamUrl: https only (http
// allowed only for loopback in dev), and never our own workers hosts
// (avoids the proxy looping back into itself).
const HTTP_LOOPBACK_RE = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i

// Extract the lowercased hostname without relying on the DOM `URL`
// global (absent in the shared package's tsconfig lib set).
function hostOf(u: string): string {
  const m = u.match(/^[a-z]+:\/\/([^/?#]+)/i)
  if (!m || !m[1]) return ''
  let host = m[1]
  const at = host.lastIndexOf('@')
  if (at >= 0) host = host.slice(at + 1)
  const colon = host.indexOf(':')
  if (colon >= 0) host = host.slice(0, colon)
  return host.toLowerCase()
}

export const GitBaseUrl = z
  .string()
  .url()
  .refine(
    (v) => v.toLowerCase().startsWith('https://') || HTTP_LOOPBACK_RE.test(v),
    'must be https (http allowed only for localhost)'
  )
  .refine((v) => {
    const h = hostOf(v)
    return h !== '' && !h.endsWith('workers.dev') && !h.endsWith('cloudflareworkers.com')
  }, 'must not be a workers.dev / cloudflareworkers.com host')

// ----- admin row + requests ----------------------------------------------

export const AdminGitSourceRow = z.object({
  id: z.string(),
  slug: GitSourceSlug,
  displayName: z.string(),
  provider: GitProvider,
  baseUrl: z.string().nullable(),
  owner: z.string(),
  project: z.string(),
  repo: z.string(),
  branch: z.string(),
  pathPrefix: z.string(),
  // Product this source belongs to; synced docs are auto-tagged with it.
  productId: z.string().nullable(),
  readStrategy: GitCredStrategy,
  writeStrategy: GitCredStrategy,
  folderRoot: z.string(),
  syncInterval: GitSyncInterval,
  enabled: z.boolean(),
  visibility: z.array(VisibilityRulePayload),
  lastSyncedAt: z.number().int().nullable(),
  lastSyncStatus: GitSyncStatus.nullable(),
  lastSyncError: z.string().nullable(),
  docCount: z.number().int().min(0),
  sharedCredentialConfigured: z.boolean(),
  currentUserConnected: z.boolean(),
  createdAt: z.number().int(),
  updatedAt: z.number().int()
})
export type AdminGitSourceRow = z.infer<typeof AdminGitSourceRow>

export const CreateGitSourceRequest = z.object({
  // `repo-` prefix enforced on new sources. The base `GitSourceSlug`
  // (used by AdminGitSourceRow) stays permissive so existing sources read.
  slug: prefixedSlug('gitSource'),
  displayName: z.string().min(1).max(120),
  provider: GitProvider,
  baseUrl: GitBaseUrl.optional(),
  owner: z.string().max(200).optional(),
  project: z.string().max(200).optional(),
  repo: z.string().min(1).max(200),
  branch: z.string().min(1).max(200),
  pathPrefix: z.string().max(200).optional(),
  productId: z.string().nullable().optional(),
  readStrategy: GitCredStrategy.optional(),
  writeStrategy: GitCredStrategy.optional(),
  folderRoot: GitFolderRoot.optional(),
  syncInterval: GitSyncInterval.optional(),
  enabled: z.boolean().optional()
})
export type CreateGitSourceRequest = z.infer<typeof CreateGitSourceRequest>

export const UpdateGitSourceRequest = z.object({
  displayName: z.string().min(1).max(120).optional(),
  baseUrl: GitBaseUrl.nullable().optional(),
  owner: z.string().max(200).optional(),
  project: z.string().max(200).optional(),
  repo: z.string().min(1).max(200).optional(),
  branch: z.string().min(1).max(200).optional(),
  pathPrefix: z.string().max(200).optional(),
  productId: z.string().nullable().optional(),
  readStrategy: GitCredStrategy.optional(),
  writeStrategy: GitCredStrategy.optional(),
  folderRoot: GitFolderRoot.optional(),
  syncInterval: GitSyncInterval.optional(),
  enabled: z.boolean().optional()
})
export type UpdateGitSourceRequest = z.infer<typeof UpdateGitSourceRequest>

// PAT for the org-level shared (read) credential, or a per-user token.
export const GitSetCredentialRequest = z.object({
  token: z.string().min(1).max(4096)
})
export type GitSetCredentialRequest = z.infer<typeof GitSetCredentialRequest>

// POST /api/admin/git-sources/:id/sync result.
export const GitSyncResult = z.object({
  status: GitSyncStatus,
  created: z.number().int().min(0),
  updated: z.number().int().min(0),
  deleted: z.number().int().min(0),
  skipped: z.number().int().min(0),
  conflicts: z.number().int().min(0),
  error: z.string().nullable()
})
export type GitSyncResult = z.infer<typeof GitSyncResult>

// ----- per-doc git status (editor panel) ---------------------------------

export const GitPrRef = z.object({
  url: z.string(),
  providerPrId: z.string(),
  state: GitPrState
})
export type GitPrRef = z.infer<typeof GitPrRef>

export const GitDocStatus = z.object({
  gitSourceId: z.string(),
  sourceSlug: z.string(),
  provider: GitProvider,
  branch: z.string(),
  path: z.string(),
  webUrl: z.string(),
  syncState: GitSyncState.nullable(),
  syncedAt: z.number().int().nullable(),
  canWrite: z.boolean(),
  pr: GitPrRef.nullable()
})
export type GitDocStatus = z.infer<typeof GitDocStatus>

// POST /api/docs/:id/git/pull-request — markdown produced client-side by
// the editor (blocksToMarkdownLossy). Capped to match the content route.
export const CreatePullRequestRequest = z.object({
  markdown: z.string().max(2 * 1024 * 1024)
})
export type CreatePullRequestRequest = z.infer<typeof CreatePullRequestRequest>

export const CreatePullRequestResult = z.object({
  // 'noop' when the normalized markdown equals the synced baseline.
  outcome: z.enum(['opened', 'updated', 'noop']),
  pr: GitPrRef.nullable()
})
export type CreatePullRequestResult = z.infer<typeof CreatePullRequestResult>
