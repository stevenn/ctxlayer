/**
 * Admin Users page — REST request / response shapes.
 *
 * `AdminUserRow` is what `GET /api/admin/users` returns per user: the
 * profile fields, current role, IdP identity, and the user's team
 * membership inline so the admin table doesn't have to N+1 fetch
 * per row.
 *
 * Audit-log shapes also live here since they're admin-facing and
 * share the same request/response style as the rest of admin REST.
 */
import { z } from 'zod'
import { Idp, Role } from './api-types'
import { RoleRef, TeamMemberRole, TeamRef } from './org-ia'

// Team membership reference embedded in AdminUserRow.
export const AdminUserTeam = TeamRef.extend({
  role: TeamMemberRole
})
export type AdminUserTeam = z.infer<typeof AdminUserTeam>

export const AdminUserRow = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullish(),
  avatarUrl: z.string().nullish(),
  role: Role,
  idp: Idp,
  createdAt: z.number().int(),
  lastSeenAt: z.number().int().nullable(),
  teams: z.array(AdminUserTeam),
  // Cross-cutting org roles the user carries (engineering, qa, …).
  // Inline so the admin table doesn't N+1 per row, same as `teams`.
  roles: z.array(RoleRef),
  // Tally of stored upstream credentials. Drives the "revoke creds"
  // button visibility — no point showing it when there's nothing to
  // revoke.
  credentialCount: z.number().int().min(0)
})
export type AdminUserRow = z.infer<typeof AdminUserRow>

export const UpdateUserRoleRequest = z.object({
  role: Role
})
export type UpdateUserRoleRequest = z.infer<typeof UpdateUserRoleRequest>

// ----- audit log read shape (forward-looking; consumed by the
// audit viewer in a later M5 phase but lives here so the admin REST
// helpers share one types module) -----

export const AuditLogEntry = z.object({
  id: z.string(),
  ts: z.number().int(),
  actorId: z.string().nullable(),
  actorEmail: z.string().nullable(),
  action: z.string(),
  target: z.string().nullable(),
  meta: z.unknown().nullable()
})
export type AuditLogEntry = z.infer<typeof AuditLogEntry>

export const AuditLogResponse = z.object({
  entries: z.array(AuditLogEntry),
  // Cursor for the next page — an absolute timestamp; pass via
  // `?before=<ts>`. `null` when we've reached the head.
  nextBefore: z.number().int().nullable()
})
export type AuditLogResponse = z.infer<typeof AuditLogResponse>
