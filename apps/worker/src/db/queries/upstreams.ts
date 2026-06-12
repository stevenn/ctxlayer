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
  if (row.transport !== 'streamable_http' && row.transport !== 'sse') {
    // Only http/sse transports are supported. Any other transport value
    // (a legacy or forged DB row) must not surface to the proxy as a
    // dialable connection. Throwing keeps it out of the M4 callers.
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
       AND u.transport IN ('streamable_http','sse')
       AND (
         v.scope_kind = 'everyone'
         OR (v.scope_kind = 'team'    AND v.scope_id IN (SELECT team_id FROM user_teams))
         OR (v.scope_kind = 'product' AND v.scope_id IN (SELECT product_id FROM user_products))
         OR (v.scope_kind = 'role'    AND v.scope_id IN (SELECT role_id FROM user_roles_cte))
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
  // M8: catalogue staleness tracking. NULL on rows cached before the
  // 0012 migration; populated on subsequent refreshes.
  input_schema_hash: string | null
  last_schema_change_at: number | null
  last_diff_summary: string | null
}

export interface CatalogueTool {
  toolName: string
  description: string | null
  inputSchema: unknown
}

export async function listCachedTools(env: Env, upstreamId: string): Promise<UpstreamToolRow[]> {
  const res = await env.DB.prepare(
    `SELECT upstream_id, tool_name, description, input_schema, cached_at,
            input_schema_hash, last_schema_change_at, last_diff_summary
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
 * Replace the entire tool cache for an upstream — the authoritative
 * `tools/list` is what just came back. M8: also computes
 * input_schema_hash per tool and bumps last_schema_change_at when the
 * hash differs from the previously cached value. Skills attached to a
 * tool whose hash changed are reported as stale at read time
 * (apps/worker/src/db/queries/skills.ts).
 *
 * Implementation: read current hashes first, then DELETE + INSERT in
 * one batch. We INSERT with the right `last_schema_change_at` for each
 * row inline, so post-batch reads see consistent values.
 */
export async function replaceCachedTools(
  env: Env,
  upstreamId: string,
  tools: CatalogueTool[]
): Promise<number> {
  const now = Math.floor(Date.now() / 1000)

  // Snapshot prior hashes + change timestamps so we can decide whether
  // a given tool's hash changed and what to preserve.
  const prior = await env.DB.prepare(
    `SELECT tool_name, input_schema, input_schema_hash,
            last_schema_change_at, last_diff_summary
     FROM upstream_tools WHERE upstream_id = ?1`
  )
    .bind(upstreamId)
    .all<{
      tool_name: string
      input_schema: string
      input_schema_hash: string | null
      last_schema_change_at: number | null
      last_diff_summary: string | null
    }>()
  const priorByName = new Map(
    (prior.results ?? []).map((r) => [
      r.tool_name,
      {
        rawSchema: r.input_schema,
        hash: r.input_schema_hash,
        lastChangeAt: r.last_schema_change_at,
        diffSummary: r.last_diff_summary
      }
    ])
  )

  // Compute hash + diff per tool (lazy import to keep cold-start lean).
  const { canonicalHash, summariseDiff } = await import('../../upstream/schema-diff')
  type Prepared = {
    toolName: string
    description: string | null
    schemaJson: string
    schemaHash: string
    lastChangeAt: number | null
    diffSummary: string | null
  }
  const prepared: Prepared[] = []
  for (const t of tools) {
    const schemaJson = JSON.stringify(t.inputSchema ?? {})
    const schemaHash = await canonicalHash(t.inputSchema ?? {})
    const priorRow = priorByName.get(t.toolName)
    if (!priorRow) {
      // New tool: record the hash; leave last_schema_change_at NULL
      // (first sight isn't a "change" — there's nothing to diff
      // against).
      prepared.push({
        toolName: t.toolName,
        description: t.description ?? null,
        schemaJson,
        schemaHash,
        lastChangeAt: null,
        diffSummary: null
      })
      continue
    }
    if (priorRow.hash === schemaHash) {
      // Unchanged: preserve BOTH the prior change timestamp AND the
      // prior diff summary. Nulling the summary here (as the
      // pre-2026-05-29 code did) made the SPA hover disappear on the
      // very next no-change refresh — operators would see "schema
      // changed Xh ago" with no tooltip explaining what changed.
      prepared.push({
        toolName: t.toolName,
        description: t.description ?? null,
        schemaJson,
        schemaHash,
        lastChangeAt: priorRow.lastChangeAt,
        diffSummary: priorRow.diffSummary
      })
      continue
    }
    if (priorRow.hash === null) {
      // First refresh after the 0012 migration on a row that existed
      // pre-migration. We don't have a prior hash to compare against,
      // so this isn't a "change" we can honestly attribute. Record
      // the new hash but leave the change timestamp + summary
      // untouched (NULL). The next genuine change will set both.
      prepared.push({
        toolName: t.toolName,
        description: t.description ?? null,
        schemaJson,
        schemaHash,
        lastChangeAt: priorRow.lastChangeAt,
        diffSummary: priorRow.diffSummary
      })
      continue
    }
    // Real change: hashes differ AND we have a real prior hash to
    // compare against. Diff + bump.
    let oldSchema: unknown = {}
    try {
      oldSchema = JSON.parse(priorRow.rawSchema)
    } catch {
      /* swallow */
    }
    const summary = summariseDiff(oldSchema, t.inputSchema ?? {})
    prepared.push({
      toolName: t.toolName,
      description: t.description ?? null,
      schemaJson,
      schemaHash,
      lastChangeAt: now,
      diffSummary: summary
    })
  }

  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(`DELETE FROM upstream_tools WHERE upstream_id = ?1`).bind(upstreamId)
  ]
  for (const p of prepared) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO upstream_tools
           (upstream_id, tool_name, description, input_schema, cached_at,
            input_schema_hash, last_schema_change_at, last_diff_summary)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
      ).bind(
        upstreamId,
        p.toolName,
        p.description,
        p.schemaJson,
        now,
        p.schemaHash,
        p.lastChangeAt,
        p.diffSummary
      )
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

// ----- upstream_shared_credentials --------------------------------------

export interface SharedCredentialRow {
  upstream_id: string
  kind: 'bearer'
  ciphertext: Uint8Array
  iv: Uint8Array
  key_version: number
  created_by: string | null
  created_at: number
  updated_at: number
}

export async function getSharedCredential(
  env: Env,
  upstreamId: string
): Promise<SharedCredentialRow | null> {
  const row = await env.DB.prepare(
    `SELECT upstream_id, kind, ciphertext, iv, key_version, created_by, created_at, updated_at
     FROM upstream_shared_credentials WHERE upstream_id = ?1`
  )
    .bind(upstreamId)
    .first<SharedCredentialRow>()
  if (!row) return null
  // Same D1-BLOB-shape normalisation as getUserCredential — see the
  // long comment there.
  row.ciphertext = toUint8Array(row.ciphertext)
  row.iv = toUint8Array(row.iv)
  return row
}

async function hasSharedCredential(env: Env, upstreamId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS one FROM upstream_shared_credentials WHERE upstream_id = ?1`
  )
    .bind(upstreamId)
    .first<{ one: number }>()
  return row !== null
}

export interface UpsertSharedCredentialInput {
  kind: 'bearer'
  ciphertext: Uint8Array
  iv: Uint8Array
  keyVersion: number
  createdBy: string
}

export async function upsertSharedCredential(
  env: Env,
  upstreamId: string,
  input: UpsertSharedCredentialInput
): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO upstream_shared_credentials
       (upstream_id, kind, ciphertext, iv, key_version, created_by, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
     ON CONFLICT (upstream_id) DO UPDATE SET
       kind = excluded.kind,
       ciphertext = excluded.ciphertext,
       iv = excluded.iv,
       key_version = excluded.key_version,
       created_by = excluded.created_by,
       updated_at = excluded.updated_at`
  )
    .bind(
      upstreamId,
      input.kind,
      input.ciphertext,
      input.iv,
      input.keyVersion,
      input.createdBy,
      now
    )
    .run()
}

export async function deleteSharedCredential(env: Env, upstreamId: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM upstream_shared_credentials WHERE upstream_id = ?1`)
    .bind(upstreamId)
    .run()
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

/**
 * Single-flight guard for user_oauth token refresh. Atomically claims a short
 * lease on the (user, upstream) credential row via a conditional UPDATE — D1
 * serializes writes, so exactly one concurrent caller wins. Returns true if
 * THIS call won the lease (and must perform the refresh); false if another
 * caller already holds it (and should wait for the rotated token rather than
 * spending the refresh_token a second time, which would trip the provider's
 * refresh-token-reuse revocation). The lease is an absolute unix-seconds
 * deadline, so a crashed holder auto-releases after `ttlSeconds`. A row must
 * already exist (an OAuth upstream always has stored tokens by refresh time);
 * with no row the UPDATE matches nothing and this returns false.
 */
export async function acquireRefreshLease(
  env: Env,
  userId: string,
  upstreamId: string,
  ttlSeconds: number
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000)
  const res = await env.DB.prepare(
    `UPDATE user_credentials SET refresh_lock_until = ?3
       WHERE user_id = ?1 AND upstream_id = ?2
         AND (refresh_lock_until IS NULL OR refresh_lock_until < ?4)`
  )
    .bind(userId, upstreamId, now + ttlSeconds, now)
    .run()
  return (res.meta?.changes ?? 0) > 0
}

/** Presence + re-auth health of a (user, upstream) credential, in one read. */
export async function getUserCredentialStatus(
  env: Env,
  userId: string,
  upstreamId: string
): Promise<{ present: boolean; needsReauth: boolean }> {
  const row = await env.DB.prepare(
    `SELECT reauth_required_at FROM user_credentials WHERE user_id = ?1 AND upstream_id = ?2`
  )
    .bind(userId, upstreamId)
    .first<{ reauth_required_at: number | null }>()
  return { present: row !== null, needsReauth: row?.reauth_required_at != null }
}

/**
 * Flag a credential as needing interactive re-auth after a definitive refresh
 * failure. Conditional so it only fires on the clear→set transition — returns
 * true when this call newly set the flag (so the caller audits once, not every
 * failing session).
 */
export async function markReauthRequired(
  env: Env,
  userId: string,
  upstreamId: string
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000)
  const res = await env.DB.prepare(
    `UPDATE user_credentials SET reauth_required_at = ?3
       WHERE user_id = ?1 AND upstream_id = ?2 AND reauth_required_at IS NULL`
  )
    .bind(userId, upstreamId, now)
    .run()
  return (res.meta?.changes ?? 0) > 0
}

/** Clear the re-auth flag after a successful token save (refresh or reconnect). */
export async function clearReauthRequired(
  env: Env,
  userId: string,
  upstreamId: string
): Promise<void> {
  await env.DB.prepare(
    `UPDATE user_credentials SET reauth_required_at = NULL
       WHERE user_id = ?1 AND upstream_id = ?2 AND reauth_required_at IS NOT NULL`
  )
    .bind(userId, upstreamId)
    .run()
}

export async function deleteUserCredential(
  env: Env,
  userId: string,
  upstreamId: string
): Promise<void> {
  await env.DB.prepare(`DELETE FROM user_credentials WHERE user_id = ?1 AND upstream_id = ?2`)
    .bind(userId, upstreamId)
    .run()
}

/**
 * Bulk lookup: which of these upstream_ids does the given user have
 * stored credentials for? Powers the SPA upstreams page (one round-trip)
 * and the MCP tool-proxy registry init.
 */
async function listUserCredentialedUpstreamIds(
  env: Env,
  userId: string
): Promise<Set<string>> {
  const res = await env.DB.prepare(`SELECT upstream_id FROM user_credentials WHERE user_id = ?1`)
    .bind(userId)
    .all<{ upstream_id: string }>()
  return new Set((res.results ?? []).map((r) => r.upstream_id))
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
  if (row.transport !== 'streamable_http' && row.transport !== 'sse') return null
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
  const credIds = await listUserCredentialedUpstreamIds(env, userId)
  const sharedFlags = await Promise.all(
    rows.map((r) =>
      r.auth_strategy === 'shared_bearer' ? hasSharedCredential(env, r.id) : Promise.resolve(false)
    )
  )
  const counts = await Promise.all(rows.map((r) => countToolsForUpstream(env, r.id)))
  return rows.map((r, i) => {
    const requiresCredentials =
      r.auth_strategy === 'user_bearer' || r.auth_strategy === 'user_oauth'
    const isShared = r.auth_strategy === 'shared_bearer'
    const connected = requiresCredentials
      ? credIds.has(r.id)
      : isShared
        ? (sharedFlags[i] ?? false)
        : true
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
