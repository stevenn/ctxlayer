/**
 * D1 queries against the `join_codes` table (plan L admission mechanism).
 *
 * A join code is a shared bearer secret an entity admin distributes. We
 * store only SHA-256(canonical-code); the plaintext is shown to the admin
 * exactly once on creation. Codes are revocable, can be domain-restricted,
 * and carry optional expiry + max-uses. Route handlers stay SQL-free.
 */

import type { Env } from '../../env'
import type { CreateJoinCodeRequest, JoinCode, JoinCodeRedeem } from '@ctxlayer/shared'
import { sha256Hex } from '../../crypto/hash'

// Crockford-ish base32 minus ambiguous glyphs (no I/L/O/U, no 0/1) so a
// code is easy to read aloud and re-type.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ'
const CODE_LEN = 16

function generateCanonicalCode(): string {
  const bytes = new Uint8Array(CODE_LEN)
  crypto.getRandomValues(bytes)
  let out = ''
  // Modulo bias here is irrelevant — a join code is a revocable, rate-able
  // shared secret, not a key. Readability beats a few fractional bits.
  for (let i = 0; i < CODE_LEN; i++) out += ALPHABET.charAt((bytes[i] as number) % ALPHABET.length)
  return out
}

function groupForDisplay(canonical: string): string {
  return canonical.match(/.{1,4}/g)?.join('-') ?? canonical
}

/** Strip separators/case so `abcd-efgh` and `ABCDEFGH` hash identically. */
export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[^0-9A-Z]/g, '')
}

interface JoinCodeRow {
  id: string
  label: string
  domain_restrict: string | null
  on_redeem: JoinCodeRedeem
  max_uses: number | null
  uses: number
  expires_at: number | null
  created_by: string | null
  created_at: number
  revoked_at: number | null
  created_by_email: string | null
}

function toJoinCode(r: JoinCodeRow): JoinCode {
  return {
    id: r.id,
    label: r.label,
    domainRestrict: r.domain_restrict,
    onRedeem: r.on_redeem,
    maxUses: r.max_uses,
    uses: r.uses,
    expiresAt: r.expires_at,
    createdBy: r.created_by,
    createdByEmail: r.created_by_email,
    createdAt: r.created_at,
    revokedAt: r.revoked_at
  }
}

const SELECT_COLS = `jc.id, jc.label, jc.domain_restrict, jc.on_redeem, jc.max_uses, jc.uses,
  jc.expires_at, jc.created_by, jc.created_at, jc.revoked_at, u.email AS created_by_email`

/** List every join code (active + revoked), newest first. Never returns the hash. */
export async function listJoinCodes(env: Env): Promise<JoinCode[]> {
  const res = await env.DB.prepare(
    `SELECT ${SELECT_COLS}
     FROM join_codes jc
     LEFT JOIN users u ON u.id = jc.created_by
     ORDER BY jc.created_at DESC`
  ).all<JoinCodeRow>()
  return (res.results ?? []).map(toJoinCode)
}

/** Create a code; returns the row plus the one-time plaintext (display form). */
export async function createJoinCode(
  env: Env,
  input: CreateJoinCodeRequest,
  createdBy: string
): Promise<{ joinCode: JoinCode; code: string }> {
  const canonical = generateCanonicalCode()
  const hash = await sha256Hex(canonical)
  const id = crypto.randomUUID().replace(/-/g, '')
  const now = Math.floor(Date.now() / 1000)
  const expiresAt = input.expiresInDays ? now + input.expiresInDays * 86400 : null

  await env.DB.prepare(
    `INSERT INTO join_codes
       (id, code_hash, label, domain_restrict, on_redeem, max_uses, uses, expires_at, created_by, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8, ?9)`
  )
    .bind(
      id,
      hash,
      input.label?.trim() || '',
      input.domainRestrict ?? null,
      input.onRedeem,
      input.maxUses ?? null,
      expiresAt,
      createdBy,
      now
    )
    .run()

  const row = await env.DB.prepare(
    `SELECT ${SELECT_COLS}
     FROM join_codes jc LEFT JOIN users u ON u.id = jc.created_by
     WHERE jc.id = ?1`
  )
    .bind(id)
    .first<JoinCodeRow>()
  if (!row) throw new Error('join_code_create_failed')
  return { joinCode: toJoinCode(row), code: groupForDisplay(canonical) }
}

export type RedeemResult =
  | { ok: true; id: string; onRedeem: JoinCodeRedeem }
  | { ok: false; reason: 'invalid_join_code' | 'code_expired' }

/**
 * Resolve a plaintext code against the store. `invalid_join_code` covers
 * unknown / revoked / exhausted / wrong-domain (don't leak which); only a
 * genuine time expiry reports `code_expired`. Does NOT bump uses — callers
 * call `bumpJoinCodeUses` after a successful admission to win the race.
 */
export async function findRedeemableJoinCode(
  env: Env,
  code: string,
  email: string,
  now: number = Math.floor(Date.now() / 1000)
): Promise<RedeemResult> {
  const hash = await sha256Hex(normalizeCode(code))
  const row = await env.DB.prepare(
    `SELECT id, on_redeem, domain_restrict, max_uses, uses, expires_at, revoked_at
     FROM join_codes WHERE code_hash = ?1`
  )
    .bind(hash)
    .first<{
      id: string
      on_redeem: JoinCodeRedeem
      domain_restrict: string | null
      max_uses: number | null
      uses: number
      expires_at: number | null
      revoked_at: number | null
    }>()
  if (!row || row.revoked_at != null) return { ok: false, reason: 'invalid_join_code' }
  if (row.expires_at != null && now >= row.expires_at) return { ok: false, reason: 'code_expired' }
  if (row.max_uses != null && row.uses >= row.max_uses)
    return { ok: false, reason: 'invalid_join_code' }
  if (row.domain_restrict) {
    const domain = email.split('@')[1]?.toLowerCase() ?? ''
    if (domain !== row.domain_restrict.toLowerCase())
      return { ok: false, reason: 'invalid_join_code' }
  }
  return { ok: true, id: row.id, onRedeem: row.on_redeem }
}

/**
 * Atomically bump a code's use count, guarding the max-uses ceiling. Returns
 * false if the row was already exhausted/revoked (lost the race) — the caller
 * should then treat the redemption as invalid.
 */
export async function bumpJoinCodeUses(env: Env, id: string): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE join_codes SET uses = uses + 1
     WHERE id = ?1 AND revoked_at IS NULL AND (max_uses IS NULL OR uses < max_uses)`
  )
    .bind(id)
    .run()
  return (res.meta?.changes ?? 0) > 0
}

/** Revoke a code (the admin "delete" action). Keeps the row for the audit. */
export async function revokeJoinCode(env: Env, id: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `UPDATE join_codes SET revoked_at = ?1 WHERE id = ?2 AND revoked_at IS NULL`
  )
    .bind(now, id)
    .run()
}
