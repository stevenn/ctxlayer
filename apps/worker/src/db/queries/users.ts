/**
 * D1 queries against the `users` table. Route handlers MUST stay
 * SQL-free per the conventions (PLAN.md G).
 */

import type { Env } from '../../env'
import type { AdminUserRow, AdminUserTeam, Idp, Role, RoleRef, UserStatus } from '@ctxlayer/shared'

export interface UserRow {
  id: string
  email: string
  name: string | null
  avatar_url: string | null
  idp: string
  idp_sub: string
  role: Role
  status: UserStatus
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
 * Upsert by (idp, idp_sub). Returns the resulting row plus a
 * `promotedToAdmin` flag: true when the email appears in ADMIN_EMAILS,
 * so the row carries (or just gained) the admin role (idempotent). The
 * caller is responsible for audit-logging the promotion — we can't
 * easily detect the prior role without a second read, so the flag fires
 * on every sign-in by an ADMIN_EMAILS address and readers can dedupe
 * downstream if it matters.
 *
 * `admitStatus` is the lifecycle status to write for a BRAND-NEW user (the
 * admission decision — see auth/admission.ts). For an EXISTING user the
 * stored status is authoritative and is left untouched: sign-in never
 * un-suspends or re-pends a known user — only an admin flips status. The
 * caller re-reads the returned `user.status` to decide whether to issue a
 * session (active), show the pending page (pending), or reject (suspended).
 */
export async function upsertUser(
  env: Env,
  input: UpsertUserInput,
  admitStatus: UserStatus = 'active'
): Promise<{ user: UserRow; promotedToAdmin: boolean }> {
  const adminSet = parseAdminEmails(env.ADMIN_EMAILS)
  const promoteToAdmin = adminSet.has(input.email.toLowerCase())
  const now = Math.floor(Date.now() / 1000)

  // Try insert first; on conflict update mutable fields. `status` is set
  // only on INSERT — deliberately absent from the UPDATE SET clause so a
  // re-sign-in can't override an admin's suspend/approve decision.
  const id = newUlid()
  await env.DB.prepare(
    `INSERT INTO users (id, email, name, avatar_url, idp, idp_sub, role, status, created_at, last_seen_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
     ON CONFLICT(idp, idp_sub) DO UPDATE SET
       email = excluded.email,
       name = excluded.name,
       avatar_url = excluded.avatar_url,
       last_seen_at = excluded.last_seen_at,
       role = CASE WHEN ?10 = 1 THEN 'admin' ELSE users.role END`
  )
    .bind(
      id,
      input.email,
      input.name,
      input.avatarUrl,
      input.idp,
      input.idpSub,
      promoteToAdmin ? 'admin' : 'user',
      admitStatus,
      now,
      promoteToAdmin ? 1 : 0
    )
    .run()

  const row = await env.DB.prepare(
    `SELECT id, email, name, avatar_url, idp, idp_sub, role, status, created_at, last_seen_at
     FROM users WHERE idp = ?1 AND idp_sub = ?2`
  )
    .bind(input.idp, input.idpSub)
    .first<UserRow>()
  if (!row) throw new Error('user_upsert_failed')

  return { user: row, promotedToAdmin: promoteToAdmin }
}

export async function findById(env: Env, id: string): Promise<UserRow | null> {
  const row = await env.DB.prepare(
    `SELECT id, email, name, avatar_url, idp, idp_sub, role, status, created_at, last_seen_at
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

/**
 * Lean (id, email, name) list of every user. Used by aggregations
 * that need to walk all users — e.g. the admin OAuth-clients page
 * fans `listUserGrants` out over this set to attribute clients to
 * the users who authorised them.
 */
export async function listUserRefs(
  env: Env
): Promise<Array<{ id: string; email: string; name: string | null }>> {
  const res = await env.DB.prepare(`SELECT id, email, name FROM users ORDER BY LOWER(email)`).all<{
    id: string
    email: string
    name: string | null
  }>()
  return res.results ?? []
}

// ----- admin Users page ---------------------------------------------------

/**
 * Fetch every user with their team membership joined. One query + one
 * aggregation pass instead of N+1 round-trips.
 *
 * Membership joining is left-join-style: users with no team rows still
 * appear with an empty `teams` array. Credential count comes from a
 * separate aggregate query — small enough to be a second roundtrip.
 */
export async function listAdminUserRows(env: Env): Promise<AdminUserRow[]> {
  const [usersRes, teamsRes, rolesRes, credsRes] = await Promise.all([
    env.DB.prepare(
      `SELECT id, email, name, avatar_url, idp, role, status, created_at, last_seen_at
       FROM users ORDER BY LOWER(email)`
    ).all<{
      id: string
      email: string
      name: string | null
      avatar_url: string | null
      idp: string
      role: Role
      status: UserStatus
      created_at: number
      last_seen_at: number | null
    }>(),
    env.DB.prepare(
      `SELECT tm.user_id, tm.team_id, tm.role AS member_role,
              t.slug AS team_slug, t.display_name AS team_display_name,
              t.description AS team_description
       FROM team_members tm
       JOIN teams t ON t.id = tm.team_id`
    ).all<{
      user_id: string
      team_id: string
      member_role: 'member' | 'lead'
      team_slug: string
      team_display_name: string
      team_description: string | null
    }>(),
    env.DB.prepare(
      `SELECT ur.user_id, r.id AS role_id, r.slug AS role_slug,
              r.display_name AS role_display_name, r.description AS role_description
       FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id`
    ).all<{
      user_id: string
      role_id: string
      role_slug: string
      role_display_name: string
      role_description: string | null
    }>(),
    env.DB.prepare(`SELECT user_id, COUNT(*) AS n FROM user_credentials GROUP BY user_id`).all<{
      user_id: string
      n: number
    }>()
  ])

  const teamsByUser = new Map<string, AdminUserTeam[]>()
  for (const r of teamsRes.results ?? []) {
    const list = teamsByUser.get(r.user_id) ?? []
    list.push({
      id: r.team_id,
      slug: r.team_slug,
      displayName: r.team_display_name,
      description: r.team_description,
      role: r.member_role
    })
    teamsByUser.set(r.user_id, list)
  }
  const rolesByUser = new Map<string, RoleRef[]>()
  for (const r of rolesRes.results ?? []) {
    const list = rolesByUser.get(r.user_id) ?? []
    list.push({
      id: r.role_id,
      slug: r.role_slug,
      displayName: r.role_display_name,
      description: r.role_description
    })
    rolesByUser.set(r.user_id, list)
  }
  const credsByUser = new Map<string, number>()
  for (const r of credsRes.results ?? []) credsByUser.set(r.user_id, r.n)

  return (usersRes.results ?? []).map((u) => ({
    id: u.id,
    email: u.email,
    name: u.name,
    avatarUrl: u.avatar_url,
    role: u.role,
    idp: u.idp,
    status: u.status,
    createdAt: u.created_at,
    lastSeenAt: u.last_seen_at,
    teams: teamsByUser.get(u.id) ?? [],
    roles: rolesByUser.get(u.id) ?? [],
    credentialCount: credsByUser.get(u.id) ?? 0
  }))
}

/** PATCH /api/admin/users/:id role. */
export async function updateUserRole(env: Env, userId: string, role: Role): Promise<void> {
  await env.DB.prepare(`UPDATE users SET role = ?1 WHERE id = ?2`).bind(role, userId).run()
}

/**
 * Delete every stored upstream credential for the user. Returns the
 * count we just removed so the audit log + UI can show what happened.
 */
export async function revokeAllUserCredentials(env: Env, userId: string): Promise<number> {
  const before = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM user_credentials WHERE user_id = ?1`
  )
    .bind(userId)
    .first<{ n: number }>()
  await env.DB.prepare(`DELETE FROM user_credentials WHERE user_id = ?1`).bind(userId).run()
  return before?.n ?? 0
}

/**
 * Count admins who can actually still sign in (role='admin' AND
 * status='active'), optionally excluding one user id. Used by the
 * demote / suspend / delete guards: a suspended co-admin is not a
 * safety net, so "is there another *active* admin besides this target?"
 * is the right question.
 */
export async function countActiveAdmins(env: Env, exceptId?: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM users
     WHERE role = 'admin' AND status = 'active' AND id != ?1`
  )
    .bind(exceptId ?? '')
    .first<{ n: number }>()
  return row?.n ?? 0
}

/** Set a user's lifecycle status (admin-driven: approve / suspend / reactivate). */
export async function setUserStatus(env: Env, userId: string, status: UserStatus): Promise<void> {
  await env.DB.prepare(`UPDATE users SET status = ?1 WHERE id = ?2`).bind(status, userId).run()
}

/**
 * Hard-delete a user identity. The mirror row is removed; the IdP identity
 * is untouched. ON DELETE CASCADE clears team memberships, org-role grants,
 * tool-ACL grants, and stored credentials. The remaining references are
 * authored content:
 *   - nullable authorship (documents/doc_revisions/doc_editors/skill_*
 *     /doc_attachments) is de-attributed to NULL — the content survives;
 *   - `skills.created_by` is NOT NULL, so authored skills are reassigned to
 *     the acting admin (`actorId`) to keep the curated set alive + owned.
 * Audit rows survive (audit_log has no FK), so the history is intact.
 *
 * NOTE: re-provisioning. If the deleted identity is still on the env IdP
 * allowlist (or the tenant runs `open_domain`), the next sign-in re-creates
 * a fresh `active` row. To make a deletion stick, also remove them from the
 * allowlist or move the tenant onto `invite`/`request`. Returns the count of
 * skills reassigned so the caller can audit + surface it.
 */
export async function deleteUser(
  env: Env,
  userId: string,
  actorId: string
): Promise<{ reassignedSkills: number }> {
  const skillCount = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM skills WHERE created_by = ?1`
  )
    .bind(userId)
    .first<{ n: number }>()

  // Atomic: clear/reassign every NO-ACTION reference, then delete (which
  // fires the CASCADE/SET NULL children). Order matters — the user row is
  // deleted last, after nothing NOT-NULL references it.
  const stmt = (sql: string) => env.DB.prepare(sql).bind(userId)
  await env.DB.batch([
    stmt(`UPDATE documents       SET created_by = NULL WHERE created_by = ?1`),
    stmt(`UPDATE doc_revisions   SET author_id  = NULL WHERE author_id  = ?1`),
    stmt(`UPDATE doc_editors     SET granted_by = NULL WHERE granted_by = ?1`),
    stmt(`UPDATE skill_revisions SET author_id  = NULL WHERE author_id  = ?1`),
    stmt(`UPDATE skill_attachments SET created_by = NULL WHERE created_by = ?1`),
    stmt(`UPDATE doc_attachments SET created_by = NULL WHERE created_by = ?1`),
    env.DB.prepare(`UPDATE skills SET created_by = ?1 WHERE created_by = ?2`).bind(actorId, userId),
    stmt(`DELETE FROM users WHERE id = ?1`)
  ])
  return { reassignedSkills: skillCount?.n ?? 0 }
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

/**
 * Case-insensitive email-prefix lookup for the Sharing dialog autocomplete
 * (api/users.ts). Bounded by `limit`; `escapeLike` neutralises LIKE wildcards
 * in the user-supplied prefix.
 */
export async function searchUsersByEmailPrefix(
  env: Env,
  emailPrefix: string,
  limit: number
): Promise<Array<{ id: string; email: string; name: string | null }>> {
  const like = `${escapeLike(emailPrefix)}%`
  const res = await env.DB.prepare(
    `SELECT id, email, name FROM users
     WHERE LOWER(email) LIKE ?1 ESCAPE '\\'
     ORDER BY email
     LIMIT ?2`
  )
    .bind(like, limit)
    .all<{ id: string; email: string; name: string | null }>()
  return res.results ?? []
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}
