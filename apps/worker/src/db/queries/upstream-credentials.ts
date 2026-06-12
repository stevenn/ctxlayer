/**
 * D1 queries for upstream credentials: per-user rows (`user_credentials`,
 * bearer or sealed OAuth token sets) and org-wide rows
 * (`upstream_shared_credentials`, shared_bearer strategy). Also home to
 * the user_oauth refresh-lease (single-flight token refresh) and the
 * reauth-required flag that the SPA surfaces as "reconnect needed".
 *
 * Credential rows store the raw AES-GCM ciphertext + IV — the seal/open
 * step lives in `crypto/aead.ts` and runs at the route or proxy layer,
 * not here.
 *
 * Upstream row CRUD lives in `upstreams.ts`; the cached tool catalogue
 * in `upstream-tools.ts`.
 */

import type { Env } from '../../env'

// ----- user_credentials ----------------------------------------------------

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
  await env.DB.prepare(`DELETE FROM user_credentials WHERE user_id = ?1 AND upstream_id = ?2`)
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
  const res = await env.DB.prepare(`SELECT upstream_id FROM user_credentials WHERE user_id = ?1`)
    .bind(userId)
    .all<{ upstream_id: string }>()
  return new Set((res.results ?? []).map((r) => r.upstream_id))
}

// ----- refresh lease + reauth flag ----------------------------------------

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

/**
 * Batch variant of `getUserCredentialStatus`: presence + re-auth health
 * for many upstreams in one read. Upstreams without a credential row are
 * absent from the map — callers default to `{ present: false,
 * needsReauth: false }`.
 */
export async function getUserCredentialStatuses(
  env: Env,
  userId: string,
  upstreamIds: string[]
): Promise<Map<string, { present: boolean; needsReauth: boolean }>> {
  const out = new Map<string, { present: boolean; needsReauth: boolean }>()
  if (upstreamIds.length === 0) return out
  const placeholders = upstreamIds.map((_, i) => `?${i + 2}`).join(', ')
  const res = await env.DB.prepare(
    `SELECT upstream_id, reauth_required_at FROM user_credentials
     WHERE user_id = ?1 AND upstream_id IN (${placeholders})`
  )
    .bind(userId, ...upstreamIds)
    .all<{ upstream_id: string; reauth_required_at: number | null }>()
  for (const row of res.results ?? []) {
    out.set(row.upstream_id, { present: true, needsReauth: row.reauth_required_at != null })
  }
  return out
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

// ----- upstream_shared_credentials -----------------------------------------

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

export async function hasSharedCredential(env: Env, upstreamId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS one FROM upstream_shared_credentials WHERE upstream_id = ?1`
  )
    .bind(upstreamId)
    .first<{ one: number }>()
  return row !== null
}

/** Batch variant of `hasSharedCredential`: which of these upstreams have one. */
export async function sharedCredentialUpstreamIds(
  env: Env,
  upstreamIds: string[]
): Promise<Set<string>> {
  if (upstreamIds.length === 0) return new Set()
  const placeholders = upstreamIds.map((_, i) => `?${i + 1}`).join(', ')
  const res = await env.DB.prepare(
    `SELECT upstream_id FROM upstream_shared_credentials WHERE upstream_id IN (${placeholders})`
  )
    .bind(...upstreamIds)
    .all<{ upstream_id: string }>()
  return new Set((res.results ?? []).map((r) => r.upstream_id))
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
