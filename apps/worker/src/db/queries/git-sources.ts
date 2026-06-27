/**
 * D1 queries for the git-mirror tables (`git_sources`,
 * `git_source_visibility`, `git_shared_credentials`,
 * `git_user_credentials`, `git_pull_requests`) plus the git-origin
 * columns on `documents`.
 *
 * Mirrors the shapes in `db/queries/upstreams.ts`: additive visibility
 * rules, credential rows storing raw AES-GCM ciphertext (seal/open lives
 * in `crypto/aead.ts`), and a composed admin-row hydrator. Route handlers
 * stay SQL-free.
 */

import type { Env } from '../../env'
import type {
  AdminGitSourceRow,
  GitOAuthPublic,
  GitCredStrategy,
  GitProvider,
  GitSyncInterval,
  GitSyncState,
  GitSyncStatus,
  GitPrState,
  VisibilityRulePayload
} from '@ctxlayer/shared'
import { buildPatchUpdate } from './util'
import { getGitConnectionForSource } from './git-connections'

// ----- git_sources -------------------------------------------------------

export interface GitSourceRow {
  id: string
  slug: string
  display_name: string
  // The connection that owns this repo's auth (provider/base/OAuth/token/
  // visibility). 1:1 with a source today; many repos per connection ahead.
  connection_id: string
  provider: GitProvider
  base_url: string | null
  owner: string
  project: string
  repo: string
  branch: string
  path_prefix: string
  read_strategy: GitCredStrategy
  write_strategy: GitCredStrategy
  folder_root: string
  sync_interval: GitSyncInterval
  product_id: string | null
  enabled: number
  last_synced_at: number | null
  last_sync_status: GitSyncStatus | null
  last_sync_error: string | null
  // JSON blob holding the static-OAuth client config (see 0022). NULL ⇒
  // PAT-only. Shape mirrors upstream_servers.auth_config: { oauth: {...} }.
  auth_config: string | null
  created_by: string | null
  created_at: number
  updated_at: number
}

const SELECT_GIT_SOURCE = `SELECT id, slug, display_name, connection_id, provider, base_url, owner, project,
  repo, branch, path_prefix, read_strategy, write_strategy, folder_root, sync_interval, product_id,
  enabled, last_synced_at, last_sync_status, last_sync_error, auth_config, created_by, created_at, updated_at
  FROM git_sources`

export async function listGitSources(env: Env): Promise<GitSourceRow[]> {
  const res = await env.DB.prepare(`${SELECT_GIT_SOURCE} ORDER BY display_name`).all<GitSourceRow>()
  return res.results ?? []
}

export async function listEnabledGitSources(env: Env): Promise<GitSourceRow[]> {
  const res = await env.DB.prepare(`${SELECT_GIT_SOURCE} WHERE enabled = 1`).all<GitSourceRow>()
  return res.results ?? []
}

export async function getGitSourceById(env: Env, id: string): Promise<GitSourceRow | null> {
  const row = await env.DB.prepare(`${SELECT_GIT_SOURCE} WHERE id = ?1`)
    .bind(id)
    .first<GitSourceRow>()
  return row ?? null
}

export interface CreateGitSourceInput {
  slug: string
  displayName: string
  provider: GitProvider
  baseUrl?: string | null
  owner?: string
  project?: string
  repo: string
  /** Blank ⇒ auto-detect the repo's default branch on first sync. */
  branch?: string
  /** Attach to an existing connection (share its auth); omit to create one. */
  connectionId?: string
  pathPrefix?: string
  productId?: string | null
  readStrategy?: GitCredStrategy
  writeStrategy?: GitCredStrategy
  folderRoot?: string
  syncInterval?: GitSyncInterval
  enabled?: boolean
  createdBy: string
}

export async function createGitSource(
  env: Env,
  input: CreateGitSourceInput
): Promise<GitSourceRow> {
  const id = newId()
  // A new source also gets its own connection (auth holder), 1:1 for now —
  // Phase 2 will let `connectionId` be supplied to add a repo to an existing
  // connection. Deterministic conn id keyed off the source id.
  const connectionId = input.connectionId ?? `conn_${id}`
  const now = Math.floor(Date.now() / 1000)
  const stmts: D1PreparedStatement[] = []
  if (!input.connectionId) {
    const connSlug = input.slug.startsWith('repo-') ? `conn-${input.slug.slice(5)}` : `conn-${input.slug}`
    stmts.push(
      env.DB.prepare(
        `INSERT INTO git_connections
           (id, slug, display_name, provider, base_url, read_strategy, write_strategy,
            auth_config, created_by, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8, ?9, ?9)`
      ).bind(
        connectionId,
        connSlug,
        input.displayName,
        input.provider,
        input.baseUrl ?? null,
        input.readStrategy ?? 'shared_bearer',
        input.writeStrategy ?? 'user_bearer',
        input.createdBy,
        now
      )
    )
  }
  stmts.push(
    env.DB.prepare(
      `INSERT INTO git_sources
         (id, slug, display_name, connection_id, provider, base_url, owner, project, repo, branch,
          path_prefix, read_strategy, write_strategy, folder_root, sync_interval, enabled,
          product_id, created_by, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?19)`
    ).bind(
      id,
      input.slug,
      input.displayName,
      connectionId,
      input.provider,
      input.baseUrl ?? null,
      input.owner ?? '',
      input.project ?? '',
      input.repo,
      input.branch ?? '',
      input.pathPrefix ?? '',
      input.readStrategy ?? 'shared_bearer',
      input.writeStrategy ?? 'user_bearer',
      input.folderRoot ?? '',
      input.syncInterval ?? 'daily',
      input.enabled === false ? 0 : 1,
      input.productId ?? null,
      input.createdBy,
      now
    )
  )
  await env.DB.batch(stmts)
  const row = await getGitSourceById(env, id)
  if (!row) throw new Error('git_source_insert_lost')
  return row
}

export interface PatchGitSourceInput {
  displayName?: string
  baseUrl?: string | null
  owner?: string
  project?: string
  repo?: string
  branch?: string
  pathPrefix?: string
  productId?: string | null
  readStrategy?: GitCredStrategy
  writeStrategy?: GitCredStrategy
  folderRoot?: string
  syncInterval?: GitSyncInterval
  enabled?: boolean
}

export async function patchGitSource(
  env: Env,
  id: string,
  patch: PatchGitSourceInput
): Promise<void> {
  const update = buildPatchUpdate(
    'git_sources',
    {
      display_name: patch.displayName,
      base_url: patch.baseUrl,
      owner: patch.owner,
      project: patch.project,
      repo: patch.repo,
      branch: patch.branch,
      path_prefix: patch.pathPrefix,
      product_id: patch.productId,
      read_strategy: patch.readStrategy,
      write_strategy: patch.writeStrategy,
      folder_root: patch.folderRoot,
      sync_interval: patch.syncInterval,
      enabled: patch.enabled === undefined ? undefined : patch.enabled ? 1 : 0
    },
    id
  )
  if (!update) return
  await env.DB.prepare(update.sql)
    .bind(...update.binds)
    .run()
}

export async function deleteGitSource(env: Env, id: string): Promise<void> {
  // Delete the owning CONNECTION, which CASCADEs the source row + its
  // visibility + creds; the source CASCADE in turn drops PR rows and SET-NULLs
  // documents.git_source_id (synced docs survive as ordinary docs). 1:1 today;
  // Phase 2 will delete only the connection when the last repo is removed.
  await env.DB.prepare(
    `DELETE FROM git_connections WHERE id = (SELECT connection_id FROM git_sources WHERE id = ?1)`
  )
    .bind(id)
    .run()
}

export async function recordSyncResult(
  env: Env,
  id: string,
  status: GitSyncStatus,
  error: string | null
): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `UPDATE git_sources
     SET last_synced_at = ?1, last_sync_status = ?2, last_sync_error = ?3, updated_at = ?1
     WHERE id = ?4`
  )
    .bind(now, status, error, id)
    .run()
}

// ----- visibility (per-connection) ---------------------------------------

interface VisibilityRow {
  scope_kind: 'everyone' | 'team' | 'product'
  scope_id: string
}

// Visibility now lives on the CONNECTION; we resolve a source's connection via
// subquery so callers keep passing a source id. CONN_OF(?n) inlines that.
const CONN_OF = (p: string) => `(SELECT connection_id FROM git_sources WHERE id = ${p})`

async function listVisibilityForGitSource(
  env: Env,
  gitSourceId: string
): Promise<VisibilityRulePayload[]> {
  const res = await env.DB.prepare(
    `SELECT scope_kind, scope_id FROM git_connection_visibility WHERE connection_id = ${CONN_OF('?1')}`
  )
    .bind(gitSourceId)
    .all<VisibilityRow>()
  return (res.results ?? []).map((r) => ({
    scopeKind: r.scope_kind,
    scopeId: r.scope_kind === 'everyone' ? null : r.scope_id
  }))
}

export async function replaceGitSourceVisibility(
  env: Env,
  gitSourceId: string,
  rules: VisibilityRulePayload[]
): Promise<void> {
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(
      `DELETE FROM git_connection_visibility WHERE connection_id = ${CONN_OF('?1')}`
    ).bind(gitSourceId)
  ]
  for (const r of rules) {
    const scopeId = r.scopeKind === 'everyone' ? '' : (r.scopeId ?? '')
    if (r.scopeKind !== 'everyone' && !scopeId) continue
    stmts.push(
      env.DB.prepare(
        `INSERT INTO git_connection_visibility (connection_id, scope_kind, scope_id)
         VALUES (${CONN_OF('?1')}, ?2, ?3)
         ON CONFLICT (connection_id, scope_kind, scope_id) DO NOTHING`
      ).bind(gitSourceId, r.scopeKind, scopeId)
    )
  }
  await env.DB.batch(stmts)
}

export async function isGitSourceVisibleToUser(
  env: Env,
  gitSourceId: string,
  userId: string
): Promise<boolean> {
  const row = await env.DB.prepare(
    `WITH user_teams AS (SELECT team_id FROM team_members WHERE user_id = ?2),
          user_products AS (
            SELECT DISTINCT tp.product_id FROM team_products tp
            JOIN user_teams ut ON ut.team_id = tp.team_id
          )
     SELECT 1 AS one FROM git_connection_visibility v
     WHERE v.connection_id = ${CONN_OF('?1')} AND (
       v.scope_kind = 'everyone'
       OR (v.scope_kind = 'team'    AND v.scope_id IN (SELECT team_id FROM user_teams))
       OR (v.scope_kind = 'product' AND v.scope_id IN (SELECT product_id FROM user_products))
     ) LIMIT 1`
  )
    .bind(gitSourceId, userId)
    .first<{ one: number }>()
  return row !== null
}

// ----- credentials (shared + per-user) -----------------------------------

export interface GitSharedCredentialRow {
  connection_id: string
  kind: 'bearer'
  ciphertext: Uint8Array
  iv: Uint8Array
  key_version: number
  created_by: string | null
  created_at: number
  updated_at: number
}

export async function getGitSharedCredential(
  env: Env,
  gitSourceId: string
): Promise<GitSharedCredentialRow | null> {
  const row = await env.DB.prepare(
    `SELECT connection_id, kind, ciphertext, iv, key_version, created_by, created_at, updated_at
     FROM git_shared_credentials WHERE connection_id = ${CONN_OF('?1')}`
  )
    .bind(gitSourceId)
    .first<GitSharedCredentialRow>()
  if (!row) return null
  row.ciphertext = toUint8Array(row.ciphertext)
  row.iv = toUint8Array(row.iv)
  return row
}

async function hasGitSharedCredential(env: Env, gitSourceId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS one FROM git_shared_credentials WHERE connection_id = ${CONN_OF('?1')}`
  )
    .bind(gitSourceId)
    .first<{ one: number }>()
  return row !== null
}

export interface SealedInput {
  ciphertext: Uint8Array
  iv: Uint8Array
  keyVersion: number
}

export async function upsertGitSharedCredential(
  env: Env,
  gitSourceId: string,
  input: SealedInput & { createdBy: string }
): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO git_shared_credentials
       (connection_id, kind, ciphertext, iv, key_version, created_by, created_at, updated_at)
     VALUES (${CONN_OF('?1')}, 'bearer', ?2, ?3, ?4, ?5, ?6, ?6)
     ON CONFLICT (connection_id) DO UPDATE SET
       ciphertext = excluded.ciphertext, iv = excluded.iv,
       key_version = excluded.key_version, created_by = excluded.created_by,
       updated_at = excluded.updated_at`
  )
    .bind(gitSourceId, input.ciphertext, input.iv, input.keyVersion, input.createdBy, now)
    .run()
}

export async function deleteGitSharedCredential(env: Env, gitSourceId: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM git_shared_credentials WHERE connection_id = ${CONN_OF('?1')}`)
    .bind(gitSourceId)
    .run()
}

export interface GitUserCredentialRow {
  user_id: string
  connection_id: string
  kind: 'bearer' | 'oauth'
  ciphertext: Uint8Array
  iv: Uint8Array
  key_version: number
  created_at: number
  updated_at: number
}

export async function getGitUserCredential(
  env: Env,
  userId: string,
  gitSourceId: string
): Promise<GitUserCredentialRow | null> {
  const row = await env.DB.prepare(
    `SELECT user_id, connection_id, kind, ciphertext, iv, key_version, created_at, updated_at
     FROM git_user_credentials WHERE user_id = ?1 AND connection_id = ${CONN_OF('?2')}`
  )
    .bind(userId, gitSourceId)
    .first<GitUserCredentialRow>()
  if (!row) return null
  row.ciphertext = toUint8Array(row.ciphertext)
  row.iv = toUint8Array(row.iv)
  return row
}

async function hasGitUserCredential(
  env: Env,
  userId: string,
  gitSourceId: string
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS one FROM git_user_credentials WHERE user_id = ?1 AND connection_id = ${CONN_OF('?2')}`
  )
    .bind(userId, gitSourceId)
    .first<{ one: number }>()
  return row !== null
}

export async function upsertGitUserCredential(
  env: Env,
  userId: string,
  gitSourceId: string,
  input: SealedInput & { kind: 'bearer' | 'oauth' }
): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO git_user_credentials
       (user_id, connection_id, kind, ciphertext, iv, key_version, created_at, updated_at)
     VALUES (?1, ${CONN_OF('?2')}, ?3, ?4, ?5, ?6, ?7, ?7)
     ON CONFLICT (user_id, connection_id) DO UPDATE SET
       kind = excluded.kind, ciphertext = excluded.ciphertext, iv = excluded.iv,
       key_version = excluded.key_version, updated_at = excluded.updated_at`
  )
    .bind(userId, gitSourceId, input.kind, input.ciphertext, input.iv, input.keyVersion, now)
    .run()
}

export async function deleteGitUserCredential(
  env: Env,
  userId: string,
  gitSourceId: string
): Promise<void> {
  await env.DB.prepare(
    `DELETE FROM git_user_credentials WHERE user_id = ?1 AND connection_id = ${CONN_OF('?2')}`
  )
    .bind(userId, gitSourceId)
    .run()
}

// ----- documents git-origin columns --------------------------------------

export interface GitDocOrigin {
  id: string
  git_source_id: string
  git_path: string
  git_blob_sha: string | null
  git_commit_sha: string | null
  git_synced_at: number | null
  git_sync_state: GitSyncState | null
}

export async function getDocGitOrigin(env: Env, docId: string): Promise<GitDocOrigin | null> {
  const row = await env.DB.prepare(
    `SELECT id, git_source_id, git_path, git_blob_sha, git_commit_sha, git_synced_at, git_sync_state
     FROM documents WHERE id = ?1 AND git_source_id IS NOT NULL AND deleted_at IS NULL`
  )
    .bind(docId)
    .first<GitDocOrigin>()
  return row ?? null
}

export interface GitDocPathRow {
  id: string
  git_path: string
  git_blob_sha: string | null
  git_commit_sha: string | null
  git_sync_state: GitSyncState | null
}

/**
 * Every non-deleted doc mirrored from a source, with the fields the sync
 * loop needs to decide skip / conflict / update per tree entry — so a
 * sync run does ONE read here instead of a per-path lookup per file.
 */
export async function listGitDocPaths(env: Env, gitSourceId: string): Promise<GitDocPathRow[]> {
  const res = await env.DB.prepare(
    `SELECT id, git_path, git_blob_sha, git_commit_sha, git_sync_state FROM documents
     WHERE git_source_id = ?1 AND deleted_at IS NULL`
  )
    .bind(gitSourceId)
    .all<GitDocPathRow>()
  return res.results ?? []
}

async function countGitDocsForSource(env: Env, gitSourceId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM documents WHERE git_source_id = ?1 AND deleted_at IS NULL`
  )
    .bind(gitSourceId)
    .first<{ n: number }>()
  return row?.n ?? 0
}

export async function markDocGitOrigin(
  env: Env,
  docId: string,
  input: { sourceId: string; path: string; blobSha: string; commitSha: string }
): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `UPDATE documents
     SET git_source_id = ?2, git_path = ?3, git_blob_sha = ?4, git_commit_sha = ?5,
         git_synced_at = ?6, git_sync_state = 'clean'
     WHERE id = ?1`
  )
    .bind(docId, input.sourceId, input.path, input.blobSha, input.commitSha, now)
    .run()
}

export async function setDocGitSyncState(
  env: Env,
  docId: string,
  state: GitSyncState
): Promise<void> {
  await env.DB.prepare(`UPDATE documents SET git_sync_state = ?2 WHERE id = ?1`)
    .bind(docId, state)
    .run()
}

/**
 * Flag a git-sourced doc as locally edited after an editor save, so inbound
 * cron sync won't clobber the edit (the guard in git/sync.ts only protects
 * `local_edits` / `pr_open`). Conditional: only a CLEAN git doc flips — a
 * non-git doc (`git_source_id` NULL) or one already in local_edits / pr_open /
 * conflict is left untouched. A cheap no-op for the common non-git save.
 */
export async function markGitDocLocallyEdited(env: Env, docId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE documents SET git_sync_state = 'local_edits'
       WHERE id = ?1 AND git_source_id IS NOT NULL AND git_sync_state = 'clean'`
  )
    .bind(docId)
    .run()
}

// ----- git_pull_requests -------------------------------------------------

export interface GitPrRow {
  id: string
  git_source_id: string
  doc_id: string
  branch_name: string
  provider_pr_id: string
  url: string
  state: GitPrState
  opened_by: string | null
  base_commit_sha: string | null
  created_at: number
  updated_at: number
}

const SELECT_PR = `SELECT id, git_source_id, doc_id, branch_name, provider_pr_id, url, state,
  opened_by, base_commit_sha, created_at, updated_at FROM git_pull_requests`

export async function getOpenPrForDoc(env: Env, docId: string): Promise<GitPrRow | null> {
  const row = await env.DB.prepare(`${SELECT_PR} WHERE doc_id = ?1 AND state = 'open'`)
    .bind(docId)
    .first<GitPrRow>()
  return row ?? null
}

export async function getLatestPrForDoc(env: Env, docId: string): Promise<GitPrRow | null> {
  const row = await env.DB.prepare(
    `${SELECT_PR} WHERE doc_id = ?1 ORDER BY created_at DESC LIMIT 1`
  )
    .bind(docId)
    .first<GitPrRow>()
  return row ?? null
}

export async function insertGitPr(
  env: Env,
  input: {
    gitSourceId: string
    docId: string
    branchName: string
    providerPrId: string
    url: string
    openedBy: string | null
    baseCommitSha: string | null
  }
): Promise<GitPrRow> {
  const id = newId()
  const now = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO git_pull_requests
       (id, git_source_id, doc_id, branch_name, provider_pr_id, url, state, opened_by,
        base_commit_sha, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'open', ?7, ?8, ?9, ?9)`
  )
    .bind(
      id,
      input.gitSourceId,
      input.docId,
      input.branchName,
      input.providerPrId,
      input.url,
      input.openedBy,
      input.baseCommitSha,
      now
    )
    .run()
  const row = await env.DB.prepare(`${SELECT_PR} WHERE id = ?1`).bind(id).first<GitPrRow>()
  if (!row) throw new Error('git_pr_insert_lost')
  return row
}

export async function updateGitPrState(env: Env, id: string, state: GitPrState): Promise<void> {
  await env.DB.prepare(`UPDATE git_pull_requests SET state = ?2, updated_at = ?3 WHERE id = ?1`)
    .bind(id, state, Math.floor(Date.now() / 1000))
    .run()
}

// ----- composition for the admin row -------------------------------------

export async function gitAdminRowFor(
  env: Env,
  gitSourceId: string,
  callerUserId: string
): Promise<AdminGitSourceRow | null> {
  const row = await getGitSourceById(env, gitSourceId)
  if (!row) return null
  const [visibility, docCount, sharedConfigured, userConnected, connection] = await Promise.all([
    listVisibilityForGitSource(env, gitSourceId),
    countGitDocsForSource(env, gitSourceId),
    hasGitSharedCredential(env, gitSourceId),
    hasGitUserCredential(env, callerUserId, gitSourceId),
    getGitConnectionForSource(env, gitSourceId)
  ])
  // OAuth client config lives on the connection (shared across its repos).
  const authConfig = connection?.auth_config ?? null
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
    connectionId: row.connection_id,
    provider: row.provider,
    baseUrl: row.base_url,
    owner: row.owner,
    project: row.project,
    repo: row.repo,
    branch: row.branch,
    pathPrefix: row.path_prefix,
    readStrategy: row.read_strategy,
    writeStrategy: row.write_strategy,
    folderRoot: row.folder_root,
    syncInterval: row.sync_interval,
    productId: row.product_id,
    enabled: row.enabled === 1,
    visibility,
    lastSyncedAt: row.last_synced_at,
    lastSyncStatus: row.last_sync_status,
    lastSyncError: row.last_sync_error,
    docCount,
    sharedCredentialConfigured: sharedConfigured,
    oauth: oauthPublic(authConfig),
    clientSecretConfigured: oauthSecretIsSet(authConfig),
    currentUserConnected: userConnected,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/** Non-secret view of the static-OAuth config (clientId + URLs + scopes), or null. */
function oauthPublic(authConfig: string | null): GitOAuthPublic | null {
  const o = parseOauthBlock(authConfig)
  const clientId = typeof o?.clientId === 'string' ? o.clientId : ''
  const authorizeUrl = typeof o?.authorizeUrl === 'string' ? o.authorizeUrl : ''
  const tokenUrl = typeof o?.tokenUrl === 'string' ? o.tokenUrl : ''
  if (!clientId || !authorizeUrl || !tokenUrl) return null
  const scopes =
    o && Array.isArray(o.scopes) ? o.scopes.filter((s): s is string => typeof s === 'string') : []
  return { clientId, authorizeUrl, tokenUrl, scopes }
}

function oauthSecretIsSet(authConfig: string | null): boolean {
  return Boolean(parseOauthBlock(authConfig)?.clientSecretCiphertext)
}

function parseOauthBlock(authConfig: string | null): Record<string, unknown> | undefined {
  if (!authConfig) return undefined
  try {
    return (JSON.parse(authConfig) as { oauth?: Record<string, unknown> }).oauth
  } catch {
    return undefined
  }
}

// ----- helpers -----------------------------------------------------------

function toUint8Array(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v
  if (v instanceof ArrayBuffer) return new Uint8Array(v)
  if (Array.isArray(v)) return new Uint8Array(v)
  return new Uint8Array(v as ArrayLike<number>)
}

function newId(): string {
  return crypto.randomUUID().replace(/-/g, '')
}
