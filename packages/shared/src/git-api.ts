import { z } from 'zod'
import { FolderPath } from './docs-types'
import { VisibilityRulePayload } from './upstream-api'
import { prefixedSlug } from './slug'
import { isHttpsOrLoopback } from './url-trust'

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

// Base URL trust boundary — same rules as UpstreamUrl, shared via
// `url-trust.ts`: https only (http allowed only for loopback in dev). The
// self-loop guard (never ctxlayer's own host) is enforced server-side in
// the admin handler via `isSameOrigin`, since it needs `PUBLIC_BASE_URL`.
export const GitBaseUrl = z
  .url()
  .refine(isHttpsOrLoopback, 'must be https (http allowed only for localhost)')

// ----- admin row + requests ----------------------------------------------

// Non-secret view of a source's static-OAuth client config (for form prefill).
export const GitOAuthPublic = z.object({
  clientId: z.string(),
  authorizeUrl: z.string(),
  tokenUrl: z.string(),
  scopes: z.array(z.string())
})
export type GitOAuthPublic = z.infer<typeof GitOAuthPublic>

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
  // The source's static-OAuth client config (NON-secret fields only) for the
  // admin form to prefill, or null when OAuth isn't configured.
  oauth: GitOAuthPublic.nullable().default(null),
  // True iff an OAuth client secret is sealed on this source. The secret
  // itself is never returned; this drives the "secret set" placeholder.
  clientSecretConfigured: z.boolean().default(false),
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
  // Blank/omitted ⇒ auto-detect the repo's default branch on first sync.
  branch: z.string().max(200).optional(),
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
  // Blank ⇒ reset to auto-detect the repo's default branch on next sync.
  branch: z.string().max(200).optional(),
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

// Admin: configure a source's static (pre-registered) OAuth client. DCR is not
// used (see J-git.md), so the operator supplies the app's endpoints + id, and
// optionally the secret (sealed server-side; never round-tripped on read).
const HttpsUrl = z
  .url()
  .refine((v) => v.startsWith('https://'), { error: 'must be https' })

export const GitOAuthConfigRequest = z.object({
  clientId: z.string().min(1).max(512),
  authorizeUrl: HttpsUrl,
  tokenUrl: HttpsUrl,
  scopes: z.array(z.string().max(200)).max(50).default([]),
  // Write-only. Omit on edit to keep the existing sealed secret.
  clientSecret: z.string().min(1).max(4096).optional()
})
export type GitOAuthConfigRequest = z.infer<typeof GitOAuthConfigRequest>

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
  // The connection's write strategy + whether THIS user has connected their
  // own token. Together they drive the rail's "smart connect": a per-user
  // strategy (user_oauth/user_bearer) with currentUserConnected=false is the
  // only case that should surface Connect; shared-token sources never do.
  writeStrategy: GitCredStrategy.default('user_bearer'),
  currentUserConnected: z.boolean().default(false),
  // True iff the connection has static-OAuth configured — Connect-via-OAuth
  // vs the paste-a-PAT field.
  oauthConfigured: z.boolean().default(false),
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

// POST /api/docs/:id/git/review-url — commit the branch, then return the
// provider's New-PR deep-link for the user to review + open in the provider
// UI. `redirectUrl` is null only on a no-op with no existing PR (nothing to
// open). `branch` is the head branch the change was pushed to.
export const GitReviewUrlResult = z.object({
  redirectUrl: z.string().nullable(),
  branch: z.string().nullable()
})
export type GitReviewUrlResult = z.infer<typeof GitReviewUrlResult>

