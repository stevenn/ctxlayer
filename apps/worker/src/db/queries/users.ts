/**
 * D1 queries against the `users` table. Route handlers MUST stay
 * SQL-free per the conventions (PLAN.md G).
 */

import type { Env } from '../../env'
import type { Idp, Role } from '@ctxlayer/shared'

export interface UserRow {
  id: string
  email: string
  name: string | null
  avatar_url: string | null
  idp: string
  idp_sub: string
  role: Role
  created_at: number
  last_seen_at: number | null
}

export interface UpsertUserInput {
  idp: Idp
  idpSub: string
  email: string
  name: string | null
  avatarUrl: string | null
}

/**
 * Upsert by (idp, idp_sub). Returns the resulting row. Also promotes the
 * user to admin if their email appears in ADMIN_EMAILS (idempotent).
 */
export async function upsertUser(env: Env, input: UpsertUserInput): Promise<UserRow> {
  const adminSet = parseAdminEmails(env.ADMIN_EMAILS)
  const promoteToAdmin = adminSet.has(input.email.toLowerCase())
  const now = Math.floor(Date.now() / 1000)

  // Try insert first; on conflict update mutable fields.
  const id = newUlid()
  await env.DB.prepare(
    `INSERT INTO users (id, email, name, avatar_url, idp, idp_sub, role, created_at, last_seen_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
     ON CONFLICT(idp, idp_sub) DO UPDATE SET
       email = excluded.email,
       name = excluded.name,
       avatar_url = excluded.avatar_url,
       last_seen_at = excluded.last_seen_at,
       role = CASE WHEN ?9 = 1 THEN 'admin' ELSE users.role END`
  )
    .bind(
      id,
      input.email,
      input.name,
      input.avatarUrl,
      input.idp,
      input.idpSub,
      promoteToAdmin ? 'admin' : 'user',
      now,
      promoteToAdmin ? 1 : 0
    )
    .run()

  const row = await env.DB.prepare(
    `SELECT id, email, name, avatar_url, idp, idp_sub, role, created_at, last_seen_at
     FROM users WHERE idp = ?1 AND idp_sub = ?2`
  )
    .bind(input.idp, input.idpSub)
    .first<UserRow>()
  if (!row) throw new Error('user_upsert_failed')

  // Audit-log the promotion only when the row's role flipped to admin in
  // this transaction. Cheap heuristic: if promoteToAdmin AND row.role is
  // now 'admin' AND created_at == now (just-created) OR previously
  // recorded role wasn't admin, log it. We can't easily detect the prior
  // state from D1 without a second read, so we audit every sign-in that
  // resulted in admin role *and* mention of email in ADMIN_EMAILS — the
  // entries are de-duplicated downstream by reader queries if needed.
  if (promoteToAdmin) {
    await env.DB.prepare(
      `INSERT INTO audit_log (id, ts, actor_id, action, target, meta) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
    )
      .bind(newUlid(), now, row.id, 'user.admin_promote', row.id, JSON.stringify({ via: 'ADMIN_EMAILS' }))
      .run()
  }

  return row
}

export async function findById(env: Env, id: string): Promise<UserRow | null> {
  const row = await env.DB.prepare(
    `SELECT id, email, name, avatar_url, idp, idp_sub, role, created_at, last_seen_at
     FROM users WHERE id = ?1`
  )
    .bind(id)
    .first<UserRow>()
  return row ?? null
}

export async function bumpLastSeen(env: Env, id: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  await env.DB.prepare(`UPDATE users SET last_seen_at = ?1 WHERE id = ?2`).bind(now, id).run()
}

// ----- helpers ------------------------------------------------------------

function parseAdminEmails(raw: string | undefined): Set<string> {
  if (!raw) return new Set()
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  )
}

/**
 * Minimal ULID-like generator using crypto.randomUUID. Stored as TEXT in
 * D1; collisions are not a concern at this scale. If a strict ULID is
 * needed later, swap for a real implementation.
 */
function newUlid(): string {
  return crypto.randomUUID().replace(/-/g, '')
}
