/**
 * D1 queries for the upstream-proxy tables (`upstream_servers`,
 * `upstream_visibility`, `upstream_tools`, `user_credentials`).
 *
 * Visibility rules are additive (any matching row grants access);
 * tool catalogue rows are per-upstream and shared across users.
 *
 * Credential rows store the raw AES-GCM ciphertext + IV — the seal/open
 * step lives in `crypto/aead.ts` and runs at the route or proxy layer,
 * not here.
 */

import type { Env } from '../../env'
import type {
  AdminUpstreamRow,
  SupportedTransport,
  UserUpstreamSummary,
  VisibilityRulePayload
} from '@ctxlayer/shared'
import type { AuthStrategy, UpstreamAuthConfig } from '@ctxlayer/shared'

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

function parseAuthConfig(json: string): UpstreamAuthConfig {
  if (!json) return {}
  try {
    return JSON.parse(json) as UpstreamAuthConfig
  } catch {
    return {}
  }
}

export function toUpstreamConnection(row: UpstreamServerRow): UpstreamConnection {
  if (row.transport !== 'streamable_http' && row.transport !== 'sse') {
    // Parked transports (e.g. 'stdio_daytona') should not surface to
    // M4 callers. Treat as disabled.
    throw new Error(`unsupported_transport:${row.transport}`)
  }
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
    transport: row.transport as SupportedTransport,
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

export async function getUpstreamById(
  env: Env,
  id: string
): Promise<UpstreamServerRow | null> {
  const row = await env.DB.prepare(
    `SELECT id, slug, display_name, transport, url, auth_strategy, auth_config,
            enabled, created_at, updated_at
     FROM upstream_servers WHERE id = ?1`
  )
    .bind(id)
    .first<UpstreamServerRow>()
  return row ?? null
}

export async function getUpstreamBySlug(
  env: Env,
  slug: string
): Promise<UpstreamServerRow | null> {
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
  const fields: string[] = []
  const binds: unknown[] = []
  const push = (col: string, val: unknown) => {
    fields.push(`${col} = ?${fields.length + 1}`)
    binds.push(val)
  }
  if (patch.displayName !== undefined) push('display_name', patch.displayName)
  if (patch.transport !== undefined) push('transport', patch.transport)
  if (patch.url !== undefined) push('url', patch.url)
  if (patch.authStrategy !== undefined) push('auth_strategy', patch.authStrategy)
  if (patch.authConfig !== undefined) push('auth_config', JSON.stringify(patch.authConfig))
  if (patch.enabled !== undefined) push('enabled', patch.enabled ? 1 : 0)
  if (fields.length === 0) return
  fields.push(`updated_at = ?${fields.length + 1}`)
  binds.push(Math.floor(Date.now() / 1000))
  binds.push(id)
  await env.DB.prepare(
    `UPDATE upstream_servers SET ${fields.join(', ')} WHERE id = ?${binds.length}`
  )
    .bind(...binds)
    .run()
}

export async function deleteUpstream(env: Env, id: string): Promise<void> {
  // CASCADE removes upstream_visibility + upstream_tools + user_credentials
  // + sandbox_sessions rows that reference this upstream.
  await env.DB.prepare(`DELETE FROM upstream_servers WHERE id = ?1`).bind(id).run()
}

// ----- upstream_visibility -----------------------------------------------

interface VisibilityRow {
  upstream_id: string
  scope_kind: 'everyone' | 'team' | 'product'
  scope_id: string
}

export async function listVisibilityForUpstream(
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
  const res = await env.DB.prepare(
    `WITH user_teams AS (
       SELECT team_id FROM team_members WHERE user_id = ?1
     ),
     user_products AS (
       SELECT DISTINCT tp.product_id
       FROM team_products tp
       JOIN user_teams ut ON ut.team_id = tp.team_id
     )
     SELECT DISTINCT u.id, u.slug, u.display_name, u.transport, u.url,
                     u.auth_strategy, u.auth_config, u.enabled,
                     u.created_at, u.updated_at
     FROM upstream_servers u
     JOIN upstream_visibility v ON v.upstream_id = u.id
     WHERE u.enabled = 1
       AND u.transport IN ('streamable_http','sse')
       AND (
         v.scope_kind = 'everyone'
         OR (v.scope_kind = 'team'    AND v.scope_id IN (SELECT team_id FROM user_teams))
         OR (v.scope_kind = 'product' AND v.scope_id IN (SELECT product_id FROM user_products))
       )
     ORDER BY u.display_name`
  )
    .bind(userId)
    .all<UpstreamServerRow>()
  return res.results ?? []
}

// ----- upstream_tools (catalogue cache) ----------------------------------

export interface UpstreamToolRow {
  upstream_id: string
  tool_name: string
  description: string | null
  input_schema: string
  cached_at: number
}

export interface CatalogueTool {
  toolName: string
  description: string | null
  inputSchema: unknown
}

export async function listCachedTools(env: Env, upstreamId: string): Promise<UpstreamToolRow[]> {
  const res = await env.DB.prepare(
    `SELECT upstream_id, tool_name, description, input_schema, cached_at
     FROM upstream_tools WHERE upstream_id = ?1
     ORDER BY tool_name`
  )
    .bind(upstreamId)
    .all<UpstreamToolRow>()
  return res.results ?? []
}

export async function getToolsCachedAt(env: Env, upstreamId: string): Promise<number | null> {
  const row = await env.DB.prepare(
    `SELECT MAX(cached_at) AS cached_at FROM upstream_tools WHERE upstream_id = ?1`
  )
    .bind(upstreamId)
    .first<{ cached_at: number | null }>()
  return row?.cached_at ?? null
}

export async function countToolsForUpstream(env: Env, upstreamId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM upstream_tools WHERE upstream_id = ?1`
  )
    .bind(upstreamId)
    .first<{ n: number }>()
  return row?.n ?? 0
}

/**
 * Replace the entire tool cache for an upstream in one batch — the
 * authoritative `tools/list` is what just came back from the upstream,
 * so any stale rows must go.
 */
export async function replaceCachedTools(
  env: Env,
  upstreamId: string,
  tools: CatalogueTool[]
): Promise<number> {
  const now = Math.floor(Date.now() / 1000)
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(`DELETE FROM upstream_tools WHERE upstream_id = ?1`).bind(upstreamId)
  ]
  for (const t of tools) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO upstream_tools (upstream_id, tool_name, description, input_schema, cached_at)
         VALUES (?1, ?2, ?3, ?4, ?5)`
      ).bind(upstreamId, t.toolName, t.description ?? null, JSON.stringify(t.inputSchema ?? {}), now)
    )
  }
  await env.DB.batch(stmts)
  return now
}

// ----- user_credentials --------------------------------------------------

export interface UserCredentialRow {
  user_id: string
  upstream_id: string
  kind: 'bearer' | 'oauth'
  ciphertext: Uint8Array
  iv: Uint8Array
  key_version: number
  created_at: number
  updated_at: number
}

export async function getUserCredential(
  env: Env,
  userId: string,
  upstreamId: string
): Promise<UserCredentialRow | null> {
  const row = await env.DB.prepare(
    `SELECT user_id, upstream_id, kind, ciphertext, iv, key_version, created_at, updated_at
     FROM user_credentials WHERE user_id = ?1 AND upstream_id = ?2`
  )
    .bind(userId, upstreamId)
    .first<UserCredentialRow>()
  if (!row) return null
  // D1 returns BLOB columns as ArrayBuffer (or, on some compat dates,
  // a plain number[]). SubtleCrypto's AES-GCM rejects both with
  // "Incorrect type for the 'iv' field on 'EncryptAlgorithm': the
  // provided value is not of type 'JsBufferSource'". Normalise once
  // at the trust boundary so callers (aead.open) stay type-pure.
  row.ciphertext = toUint8Array(row.ciphertext)
  row.iv = toUint8Array(row.iv)
  return row
}

function toUint8Array(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v
  if (v instanceof ArrayBuffer) return new Uint8Array(v)
  if (Array.isArray(v)) return new Uint8Array(v)
  // Fallback for anything array-like (Buffer-shaped objects from
  // older D1 paths). Throws if v is genuinely unrelated, which is
  // the correct behaviour.
  return new Uint8Array(v as ArrayLike<number>)
}

export interface UpsertCredentialInput {
  kind: 'bearer' | 'oauth'
  ciphertext: Uint8Array
  iv: Uint8Array
  keyVersion: number
}

export async function upsertUserCredential(
  env: Env,
  userId: string,
  upstreamId: string,
  input: UpsertCredentialInput
): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO user_credentials
       (user_id, upstream_id, kind, ciphertext, iv, key_version, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
     ON CONFLICT (user_id, upstream_id) DO UPDATE SET
       kind = excluded.kind,
       ciphertext = excluded.ciphertext,
       iv = excluded.iv,
       key_version = excluded.key_version,
       updated_at = excluded.updated_at`
  )
    .bind(userId, upstreamId, input.kind, input.ciphertext, input.iv, input.keyVersion, now)
    .run()
}

export async function deleteUserCredential(
  env: Env,
  userId: string,
  upstreamId: string
): Promise<void> {
  await env.DB.prepare(
    `DELETE FROM user_credentials WHERE user_id = ?1 AND upstream_id = ?2`
  )
    .bind(userId, upstreamId)
    .run()
}

/**
 * Bulk lookup: which of these upstream_ids does the given user have
 * stored credentials for? Powers the SPA upstreams page (one round-trip)
 * and the MCP tool-proxy registry init.
 */
export async function listUserCredentialedUpstreamIds(
  env: Env,
  userId: string
): Promise<Set<string>> {
  const res = await env.DB.prepare(
    `SELECT upstream_id FROM user_credentials WHERE user_id = ?1`
  )
    .bind(userId)
    .all<{ upstream_id: string }>()
  return new Set((res.results ?? []).map((r) => r.upstream_id))
}

// ----- composition helpers used by the REST layer ------------------------

/**
 * Hydrate an `AdminUpstreamRow` from an upstream id. Joins visibility +
 * cached tool count + cached_at. Returns null when the row is missing.
 */
export async function adminRowFor(
  env: Env,
  upstreamId: string
): Promise<AdminUpstreamRow | null> {
  const row = await getUpstreamById(env, upstreamId)
  if (!row) return null
  if (row.transport !== 'streamable_http' && row.transport !== 'sse') return null
  const [visibility, toolsCount, cachedAt] = await Promise.all([
    listVisibilityForUpstream(env, upstreamId),
    countToolsForUpstream(env, upstreamId),
    getToolsCachedAt(env, upstreamId)
  ])
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
    transport: row.transport,
    url: row.url ?? '',
    authStrategy: row.auth_strategy,
    authConfig: parseAuthConfig(row.auth_config),
    enabled: row.enabled === 1,
    visibility,
    toolsCount,
    toolsCachedAt: cachedAt,
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
  const credIds = await listUserCredentialedUpstreamIds(env, userId)
  const counts = await Promise.all(rows.map((r) => countToolsForUpstream(env, r.id)))
  return rows.map((r, i) => {
    const requiresCredentials =
      r.auth_strategy === 'user_bearer' || r.auth_strategy === 'user_oauth'
    const connected = requiresCredentials ? credIds.has(r.id) : true
    return {
      id: r.id,
      slug: r.slug,
      displayName: r.display_name,
      transport: r.transport as SupportedTransport,
      authStrategy: r.auth_strategy,
      requiresCredentials,
      connected,
      toolsCount: counts[i] ?? 0
    }
  })
}

function newId(): string {
  return crypto.randomUUID().replace(/-/g, '')
}
