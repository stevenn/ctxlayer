/**
 * D1 queries against the `invites` table (plan L admission mechanism).
 *
 * An invite pre-authorises an email: a matching sign-in is admitted as
 * `active` and the row is marked redeemed. Route handlers stay SQL-free.
 */

import type { Env } from '../../env'
import type { Invite } from '@ctxlayer/shared'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** List every invite, newest first, with inviter email joined in. */
export async function listInvites(env: Env): Promise<Invite[]> {
  const res = await env.DB.prepare(
    `SELECT i.id, i.email, i.invited_by, i.created_at, i.redeemed_at, i.redeemed_user,
            u.email AS invited_by_email
     FROM invites i
     LEFT JOIN users u ON u.id = i.invited_by
     ORDER BY i.created_at DESC`
  ).all<{
    id: string
    email: string
    invited_by: string | null
    created_at: number
    redeemed_at: number | null
    redeemed_user: string | null
    invited_by_email: string | null
  }>()
  return (res.results ?? []).map((r) => ({
    id: r.id,
    email: r.email,
    invitedBy: r.invited_by,
    invitedByEmail: r.invited_by_email,
    createdAt: r.created_at,
    redeemedAt: r.redeemed_at,
    redeemedUser: r.redeemed_user
  }))
}

export interface CreateInvitesResult {
  added: number
  skipped: number
  invalid: string[]
}

/**
 * Parse a raw paste (comma / whitespace / newline separated), normalise to
 * lowercase, drop invalids, dedupe, then insert the ones that aren't already
 * a user or an existing invite. Idempotent: re-inviting a known address is a
 * silent skip, not an error.
 */
export async function createInvites(
  env: Env,
  rawEmails: string,
  invitedBy: string
): Promise<CreateInvitesResult> {
  const invalid: string[] = []
  const seen = new Set<string>()
  for (const tok of rawEmails.split(/[\s,;]+/)) {
    const e = tok.trim().toLowerCase()
    if (!e) continue
    if (!EMAIL_RE.test(e)) {
      invalid.push(tok.trim())
      continue
    }
    seen.add(e)
  }
  const candidates = [...seen]
  if (candidates.length === 0) return { added: 0, skipped: 0, invalid }

  const placeholders = candidates.map((_, i) => `?${i + 1}`).join(', ')
  const [usersRes, invitesRes] = await Promise.all([
    env.DB.prepare(`SELECT LOWER(email) AS e FROM users WHERE LOWER(email) IN (${placeholders})`)
      .bind(...candidates)
      .all<{ e: string }>(),
    env.DB.prepare(`SELECT LOWER(email) AS e FROM invites WHERE LOWER(email) IN (${placeholders})`)
      .bind(...candidates)
      .all<{ e: string }>()
  ])
  const existing = new Set<string>()
  for (const r of usersRes.results ?? []) existing.add(r.e)
  for (const r of invitesRes.results ?? []) existing.add(r.e)

  const toAdd = candidates.filter((e) => !existing.has(e))
  let skipped = candidates.length - toAdd.length
  if (toAdd.length === 0) return { added: 0, skipped, invalid }

  const now = Math.floor(Date.now() / 1000)
  const rows = toAdd.map((email) =>
    env.DB.prepare(
      `INSERT OR IGNORE INTO invites (id, email, invited_by, created_at) VALUES (?1, ?2, ?3, ?4)`
    ).bind(crypto.randomUUID().replace(/-/g, ''), email, invitedBy, now)
  )
  const results = await env.DB.batch(rows)
  // OR IGNORE means a racing duplicate lands as 0 changes; count real adds.
  let added = 0
  for (const r of results) {
    if ((r.meta?.changes ?? 0) > 0) added++
    else skipped++
  }
  return { added, skipped, invalid }
}

/** Find an unredeemed invite for this email (case-insensitive). */
export async function findUnredeemedInvite(
  env: Env,
  email: string
): Promise<{ id: string } | null> {
  const row = await env.DB.prepare(
    `SELECT id FROM invites WHERE LOWER(email) = LOWER(?1) AND redeemed_at IS NULL`
  )
    .bind(email)
    .first<{ id: string }>()
  return row ?? null
}

/** Mark an invite redeemed by a user. */
export async function markInviteRedeemed(
  env: Env,
  inviteId: string,
  userId: string
): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `UPDATE invites SET redeemed_at = ?1, redeemed_user = ?2 WHERE id = ?3 AND redeemed_at IS NULL`
  )
    .bind(now, userId, inviteId)
    .run()
}

export async function deleteInvite(env: Env, inviteId: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM invites WHERE id = ?1`).bind(inviteId).run()
}
