/**
 * D1 queries for the upstream-server registry: `upstream_servers` row
 * CRUD plus the `upstream_visibility` rules that gate who can see (and
 * therefore use) each upstream. Visibility rules are additive — any
 * matching row grants access.
 *
 * Also home to the REST-layer composition helpers (`adminRowFor`,
 * `listUserUpstreamSummaries`) that join the sibling concerns:
 * the cached tool catalogue lives in `upstream-tools.ts`, user + shared
 * credentials in `upstream-credentials.ts`.
 */

import type { Env } from '../../env'
import type {
  AdminUpstreamRow,
  SupportedTransport,
  UserUpstreamSummary,
  VisibilityRulePayload
} from '@ctxlayer/shared'
import type { AuthStrategy, UpstreamAuthConfig } from '@ctxlayer/shared'
import { DIALABLE_TRANSPORTS, isDialableTransport } from '../../upstream/upstream-client'
import { buildPatchUpdate } from './util'
import { countToolsForUpstream, countToolsForUpstreams, getToolsCachedAt } from './upstream-tools'
import {
  getUserCredential,
  hasSharedCredential,
  listUserCredentialedUpstreamIds,
  sharedCredentialUpstreamIds
} from './upstream-credentials'

// ----- upstream_servers --------------------------------------------------

export interface UpstreamServerRow {
  id: string
  slug: string
  display_name: string
  transport: string
  url: string | null
  auth_strategy: AuthStrategy
  auth_config: string // JSON
  enabled: number
  created_at: number
  updated_at: number
}

export interface UpstreamConnection {
  id: string
  slug: string
  displayName: string
  transport: SupportedTransport
  url: string
  authStrategy: AuthStrategy
  authConfig: UpstreamAuthConfig
  enabled: boolean
}

export function parseAuthConfig(json: string): UpstreamAuthConfig {
  if (!json) return {}
  try {
    return JSON.parse(json) as UpstreamAuthConfig
  } catch {
    return {}
  }
}

/**
 * Strip OAuth secrets from an auth_config before it leaves the worker for
 * the admin SPA. The sealed/plaintext client secret and the DCR client_info
 * (which can carry a `client_secret`) are server-only; the form re-enters a
 * secret to change it and reads the `clientSecretConfigured` flag otherwise.
 */
function redactOAuthSecrets(cfg: UpstreamAuthConfig): UpstreamAuthConfig {
  if (!cfg.oauth) return cfg
  const { clientSecretCiphertext, clientSecret, client_secret, client_info, ...safe } = cfg.oauth
  void clientSecretCiphertext
  void clientSecret
  void client_secret
  void client_info
  return { ...cfg, oauth: safe }
}

export function toUpstreamConnection(row: UpstreamServerRow): UpstreamConnection {
  if (!isDialableTransport(row.transport)) {
    // Only http/sse transports are supported. Any other transport value
    // (a legacy or forged DB row) must not surface to the proxy as a
    // dialable connection. Throwing keeps it out of the M4 callers.
    throw new Error(`unsupported_transport:${row.transport}`)
  }
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
    transport: row.transport,
    url: row.url ?? '',
    authStrategy: row.auth_strategy,
    authConfig: parseAuthConfig(row.auth_config),
    enabled: row.enabled === 1
  }
}

export async function listUpstreams(env: Env): Promise<UpstreamServerRow[]> {
  const res = await env.DB.prepare(
    `SELECT id, slug, display_name, transport, url, auth_strategy, auth_config,
            enabled, created_at, updated_at
     FROM upstream_servers ORDER BY display_name`
  ).all<UpstreamServerRow>()
  return res.results ?? []
}

export async function getUpstreamById(env: Env, id: string): Promise<UpstreamServerRow | null> {
  const row = await env.DB.prepare(
    `SELECT id, slug, display_name, transport, url, auth_strategy, auth_config,
            enabled, created_at, updated_at
     FROM upstream_servers WHERE id = ?1`
  )
    .bind(id)
    .first<UpstreamServerRow>()
  return row ?? null
}

export async function getUpstreamBySlug(env: Env, slug: string): Promise<UpstreamServerRow | null> {
  const row = await env.DB.prepare(
    `SELECT id, slug, display_name, transport, url, auth_strategy, auth_config,
            enabled, created_at, updated_at
     FROM upstream_servers WHERE slug = ?1`
  )
    .bind(slug)
    .first<UpstreamServerRow>()
  return row ?? null
}

export interface CreateUpstreamInput {
  slug: string
  displayName: string
  transport: SupportedTransport
  url: string
  authStrategy: AuthStrategy
  authConfig: UpstreamAuthConfig
  enabled: boolean
}

export async function createUpstream(
  env: Env,
  input: CreateUpstreamInput
): Promise<UpstreamServerRow> {
  const id = newId()
  const now = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO upstream_servers
       (id, slug, display_name, transport, url, auth_strategy, auth_config,
        enabled, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`
  )
    .bind(
      id,
      input.slug,
      input.displayName,
      input.transport,
      input.url,
      input.authStrategy,
      JSON.stringify(input.authConfig),
      input.enabled ? 1 : 0,
      now
    )
    .run()
  const row = await getUpstreamById(env, id)
  if (!row) throw new Error('upstream_insert_lost')
  return row
}

export interface PatchUpstreamInput {
  displayName?: string
  transport?: SupportedTransport
  url?: string
  authStrategy?: AuthStrategy
  authConfig?: UpstreamAuthConfig
  enabled?: boolean
}

export async function patchUpstream(
  env: Env,
  id: string,
  patch: PatchUpstreamInput
): Promise<void> {
  const update = buildPatchUpdate(
    'upstream_servers',
    {
      display_name: patch.displayName,
      transport: patch.transport,
      url: patch.url,
      auth_strategy: patch.authStrategy,
      auth_config: patch.authConfig === undefined ? undefined : JSON.stringify(patch.authConfig),
      enabled: patch.enabled === undefined ? undefined : patch.enabled ? 1 : 0
    },
    id
  )
  if (!update) return
  await env.DB.prepare(update.sql)
    .bind(...update.binds)
    .run()
}

export async function deleteUpstream(env: Env, id: string): Promise<void> {
  // CASCADE removes upstream_visibility + upstream_tools + user_credentials
  // rows that reference this upstream.
  await env.DB.prepare(`DELETE FROM upstream_servers WHERE id = ?1`).bind(id).run()
}

// ----- upstream_visibility -----------------------------------------------

interface VisibilityRow {
  upstream_id: string
  scope_kind: 'everyone' | 'team' | 'product' | 'role'
  scope_id: string
}

async function listVisibilityForUpstream(
  env: Env,
  upstreamId: string
): Promise<VisibilityRulePayload[]> {
  const res = await env.DB.prepare(
    `SELECT upstream_id, scope_kind, scope_id
     FROM upstream_visibility WHERE upstream_id = ?1`
  )
    .bind(upstreamId)
    .all<VisibilityRow>()
  return (res.results ?? []).map((r) => ({
    scopeKind: r.scope_kind,
    scopeId: r.scope_kind === 'everyone' ? null : r.scope_id
  }))
}

export async function replaceVisibility(
  env: Env,
  upstreamId: string,
  rules: VisibilityRulePayload[]
): Promise<void> {
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(`DELETE FROM upstream_visibility WHERE upstream_id = ?1`).bind(upstreamId)
  ]
  for (const r of rules) {
    const scopeId = r.scopeKind === 'everyone' ? '' : (r.scopeId ?? '')
    if (r.scopeKind !== 'everyone' && !scopeId) continue
    stmts.push(
      env.DB.prepare(
        `INSERT INTO upstream_visibility (upstream_id, scope_kind, scope_id)
         VALUES (?1, ?2, ?3)
         ON CONFLICT (upstream_id, scope_kind, scope_id) DO NOTHING`
      ).bind(upstreamId, r.scopeKind, scopeId)
    )
  }
  await env.DB.batch(stmts)
}

/**
 * Return only the upstreams whose visibility rules admit `userId`.
 * "everyone" rows match unconditionally; team / product rows match if
 * the user is in that team or has access to that product (transitively
 * through their teams).
 *
 * Single round-trip: a subquery resolves the user's reachable team_ids
 * and product_ids, then we LEFT JOIN visibility and require at least
 * one match per upstream.
 */
export async function listUpstreamsVisibleToUser(
  env: Env,
  userId: string
): Promise<UpstreamServerRow[]> {
  // Dialable-transport filter built from the shared const: ?1 is the
  // user id, so the IN-list placeholders start at ?2.
  const transportIn = DIALABLE_TRANSPORTS.map((_, i) => `?${i + 2}`).join(',')
  const res = await env.DB.prepare(
    `WITH user_teams AS (
       SELECT team_id FROM team_members WHERE user_id = ?1
     ),
     user_products AS (
       SELECT DISTINCT tp.product_id
       FROM team_products tp
       JOIN user_teams ut ON ut.team_id = tp.team_id
     ),
     user_roles_cte AS (
       SELECT role_id FROM user_roles WHERE user_id = ?1
     )
     SELECT DISTINCT u.id, u.slug, u.display_name, u.transport, u.url,
                     u.auth_strategy, u.auth_config, u.enabled,
                     u.created_at, u.updated_at
     FROM upstream_servers u
     JOIN upstream_visibility v ON v.upstream_id = u.id
     WHERE u.enabled = 1
       AND u.transport IN (${transportIn})
       AND (
         v.scope_kind = 'everyone'
         OR (v.scope_kind = 'team'    AND v.scope_id IN (SELECT team_id FROM user_teams))
         OR (v.scope_kind = 'product' AND v.scope_id IN (SELECT product_id FROM user_products))
         OR (v.scope_kind = 'role'    AND v.scope_id IN (SELECT role_id FROM user_roles_cte))
       )
     ORDER BY u.display_name`
  )
    .bind(userId, ...DIALABLE_TRANSPORTS)
    .all<UpstreamServerRow>()
  return res.results ?? []
}

// ----- composition helpers used by the REST layer ------------------------

/**
 * Hydrate an `AdminUpstreamRow` from an upstream id. Joins visibility +
 * cached tool count + cached_at + the calling admin's connection
 * status. Returns null when the row is missing or carries an
 * unsupported (non-http/sse) transport.
 *
 * `currentUserConnected` lets the admin drawer show "you are
 * connected" / "you are not connected" badges and gate the Refresh
 * button — refresh uses the admin's own creds, so it can't work for
 * strategies the admin hasn't connected yet.
 */
export async function adminRowFor(
  env: Env,
  upstreamId: string,
  callerUserId: string
): Promise<AdminUpstreamRow | null> {
  const row = await getUpstreamById(env, upstreamId)
  if (!row) return null
  if (!isDialableTransport(row.transport)) return null
  const requiresUserCred = row.auth_strategy === 'user_bearer' || row.auth_strategy === 'user_oauth'
  const isSharedBearer = row.auth_strategy === 'shared_bearer'
  const [visibility, toolsCount, cachedAt, cred, sharedConfigured] = await Promise.all([
    listVisibilityForUpstream(env, upstreamId),
    countToolsForUpstream(env, upstreamId),
    getToolsCachedAt(env, upstreamId),
    requiresUserCred ? getUserCredential(env, callerUserId, upstreamId) : Promise.resolve(null),
    isSharedBearer ? hasSharedCredential(env, upstreamId) : Promise.resolve(false)
  ])
  // For shared_bearer, the "connection" is org-wide — every user is
  // connected as soon as the admin configures the token. For 'none'
  // there's no credential concept; always-on.
  const connectedForCaller = requiresUserCred
    ? cred !== null
    : isSharedBearer
      ? sharedConfigured
      : true
  const fullConfig = parseAuthConfig(row.auth_config)
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
    transport: row.transport,
    url: row.url ?? '',
    authStrategy: row.auth_strategy,
    authConfig: redactOAuthSecrets(fullConfig),
    enabled: row.enabled === 1,
    visibility,
    toolsCount,
    toolsCachedAt: cachedAt,
    currentUserConnected: connectedForCaller,
    sharedCredentialConfigured: sharedConfigured,
    clientSecretConfigured: Boolean(fullConfig.oauth?.clientSecretCiphertext),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/**
 * Hydrate the user-facing upstream list. Each entry already reflects
 * the caller's connected state + tool count.
 */
export async function listUserUpstreamSummaries(
  env: Env,
  userId: string
): Promise<UserUpstreamSummary[]> {
  const rows = await listUpstreamsVisibleToUser(env, userId)
  if (rows.length === 0) return []
  const sharedIds = rows.filter((r) => r.auth_strategy === 'shared_bearer').map((r) => r.id)
  const [credIds, sharedSet, counts] = await Promise.all([
    listUserCredentialedUpstreamIds(env, userId),
    sharedCredentialUpstreamIds(env, sharedIds),
    countToolsForUpstreams(
      env,
      rows.map((r) => r.id)
    )
  ])
  return rows.map((r) => {
    const requiresCredentials =
      r.auth_strategy === 'user_bearer' || r.auth_strategy === 'user_oauth'
    const isShared = r.auth_strategy === 'shared_bearer'
    const connected = requiresCredentials
      ? credIds.has(r.id)
      : isShared
        ? sharedSet.has(r.id)
        : true
    return {
      id: r.id,
      slug: r.slug,
      displayName: r.display_name,
      transport: r.transport as SupportedTransport,
      authStrategy: r.auth_strategy,
      requiresCredentials,
      connected,
      toolsCount: counts.get(r.id) ?? 0
    }
  })
}

function newId(): string {
  return crypto.randomUUID().replace(/-/g, '')
}
