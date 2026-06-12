import {
  AdminUsageResponse,
  AdminUserRow,
  AuditLogResponse,
  CreateInvitesResponse,
  CreateJoinCodeResponse,
  Invite,
  JoinCode,
  OAuthClientsPruneResponse,
  OAuthClientsResponse,
  UpdateUserRoleRequest,
  UsageResponse
} from '@ctxlayer/shared'
import type { UsageRange } from '@ctxlayer/shared'
import { z } from 'zod'
import { request } from './core'

// ----- admin users --------------------------------------------------------

const AdminUserList = z.array(AdminUserRow)
const RevokeCredsResult = z.object({ removed: z.number().int().min(0) })

export function fetchAdminUsers(signal?: AbortSignal): Promise<AdminUserRow[]> {
  return request('/api/admin/users', (b) => AdminUserList.parse(b), { signal })
}

export function adminPatchUserRole(userId: string, body: UpdateUserRoleRequest): Promise<void> {
  return request(`/api/admin/users/${encodeURIComponent(userId)}`, () => undefined, {
    method: 'PATCH',
    body: JSON.stringify(UpdateUserRoleRequest.parse(body))
  })
}

// ----- usage --------------------------------------------------------------

// Browser UTC offset, minutes east of UTC (getTimezoneOffset uses the inverse
// sign). Sent as `tz` so the day window + chart follow the viewer's calendar.
function browserTzOffsetMin(): number {
  return -new Date().getTimezoneOffset()
}

export interface FetchUsageOpts {
  range?: UsageRange
}

export function fetchUsage(
  opts: FetchUsageOpts = {},
  signal?: AbortSignal
): Promise<UsageResponse> {
  const params = new URLSearchParams()
  if (opts.range) params.set('range', opts.range)
  params.set('tz', String(browserTzOffsetMin()))
  const qs = params.toString()
  const path = qs ? `/api/usage?${qs}` : '/api/usage'
  return request(path, (b) => UsageResponse.parse(b), { signal })
}

export interface FetchAdminUsageOpts extends FetchUsageOpts {
  userId?: string
  upstreamId?: string
}

export function fetchAdminUsage(
  opts: FetchAdminUsageOpts = {},
  signal?: AbortSignal
): Promise<AdminUsageResponse> {
  const params = new URLSearchParams()
  if (opts.range) params.set('range', opts.range)
  params.set('tz', String(browserTzOffsetMin()))
  if (opts.userId) params.set('userId', opts.userId)
  if (opts.upstreamId) params.set('upstreamId', opts.upstreamId)
  const qs = params.toString()
  const path = qs ? `/api/admin/usage?${qs}` : '/api/admin/usage'
  return request(path, (b) => AdminUsageResponse.parse(b), { signal })
}

// ----- admin oauth clients ------------------------------------------------

export interface FetchAdminOAuthClientsOpts {
  cursor?: string
  limit?: number
}

export function fetchAdminOAuthClients(
  opts: FetchAdminOAuthClientsOpts = {},
  signal?: AbortSignal
): Promise<OAuthClientsResponse> {
  const params = new URLSearchParams()
  if (opts.cursor) params.set('cursor', opts.cursor)
  if (opts.limit) params.set('limit', String(opts.limit))
  const qs = params.toString()
  const path = qs ? `/api/admin/oauth-clients?${qs}` : '/api/admin/oauth-clients'
  return request(path, (b) => OAuthClientsResponse.parse(b), { signal })
}

export function pruneAdminOAuthClients(): Promise<OAuthClientsPruneResponse> {
  return request('/api/admin/oauth-clients/prune', (b) => OAuthClientsPruneResponse.parse(b), {
    method: 'POST'
  })
}

// ----- admin audit --------------------------------------------------------

export interface FetchAdminAuditOpts {
  before?: number
  action?: string
  actorId?: string
  limit?: number
}

export function fetchAdminAudit(
  opts: FetchAdminAuditOpts = {},
  signal?: AbortSignal
): Promise<AuditLogResponse> {
  const params = new URLSearchParams()
  if (opts.before !== undefined) params.set('before', String(opts.before))
  if (opts.action) params.set('action', opts.action)
  if (opts.actorId) params.set('actorId', opts.actorId)
  if (opts.limit) params.set('limit', String(opts.limit))
  const qs = params.toString()
  const path = qs ? `/api/admin/audit?${qs}` : '/api/admin/audit'
  return request(path, (b) => AuditLogResponse.parse(b), { signal })
}

export function adminRevokeUserCredentials(userId: string): Promise<{ removed: number }> {
  return request(
    `/api/admin/users/${encodeURIComponent(userId)}/credentials`,
    (b) => RevokeCredsResult.parse(b),
    { method: 'DELETE' }
  )
}

// ----- user lifecycle (plan L) --------------------------------------------

// `complete:false` = grant revocation was partial (KV hiccup) — the lockout
// still holds via the per-request status re-check, but warn the admin.
const DeleteUserResult = z.object({
  reassignedSkills: z.number(),
  complete: z.boolean().optional()
})
const SuspendResult = z.object({ revokedGrants: z.number(), complete: z.boolean().optional() })

export function adminSuspendUser(
  userId: string
): Promise<{ revokedGrants: number; complete?: boolean }> {
  return request(`/api/admin/users/${encodeURIComponent(userId)}/suspend`, (b) => SuspendResult.parse(b), {
    method: 'POST'
  })
}

// Reactivate doubles as "approve" for a pending user (both → active).
export function adminReactivateUser(userId: string): Promise<void> {
  return request(`/api/admin/users/${encodeURIComponent(userId)}/reactivate`, () => undefined, {
    method: 'POST'
  })
}

export function adminRejectUser(userId: string): Promise<void> {
  return request(`/api/admin/users/${encodeURIComponent(userId)}/reject`, () => undefined, {
    method: 'POST'
  })
}

export function adminDeleteUser(
  userId: string
): Promise<{ reassignedSkills: number; complete?: boolean }> {
  return request(`/api/admin/users/${encodeURIComponent(userId)}`, (b) => DeleteUserResult.parse(b), {
    method: 'DELETE'
  })
}

// ----- invites ------------------------------------------------------------

const InviteList = z.array(Invite)

export function fetchInvites(signal?: AbortSignal): Promise<Invite[]> {
  return request('/api/admin/invites', (b) => InviteList.parse(b), { signal })
}

export function adminCreateInvites(emails: string): Promise<CreateInvitesResponse> {
  return request('/api/admin/invites', (b) => CreateInvitesResponse.parse(b), {
    method: 'POST',
    body: JSON.stringify({ emails })
  })
}

export function adminDeleteInvite(id: string): Promise<void> {
  return request(`/api/admin/invites/${encodeURIComponent(id)}`, () => undefined, {
    method: 'DELETE'
  })
}

// ----- join codes ---------------------------------------------------------

const JoinCodeList = z.array(JoinCode)

export function fetchJoinCodes(signal?: AbortSignal): Promise<JoinCode[]> {
  return request('/api/admin/join-codes', (b) => JoinCodeList.parse(b), { signal })
}

export interface CreateJoinCodeInput {
  label?: string
  domainRestrict?: string | null
  onRedeem: 'active' | 'pending'
  maxUses?: number | null
  expiresInDays?: number | null
}

export function adminCreateJoinCode(input: CreateJoinCodeInput): Promise<CreateJoinCodeResponse> {
  return request('/api/admin/join-codes', (b) => CreateJoinCodeResponse.parse(b), {
    method: 'POST',
    body: JSON.stringify(input)
  })
}

export function adminRevokeJoinCode(id: string): Promise<void> {
  return request(`/api/admin/join-codes/${encodeURIComponent(id)}`, () => undefined, {
    method: 'DELETE'
  })
}
