/**
 * Tenant entitlement & admission shapes (plan L).
 *
 * Covers the user lifecycle `status`, the `ACCESS_POLICY` enum, and the
 * admin REST request/response shapes for invites + join codes. The
 * env-less worker side owns the *enforcement*; these are the wire types
 * shared with the SPA.
 */
import { z } from 'zod'

// Membership lifecycle. `active` signs in; `pending` is awaiting admin
// approval (no session); `suspended` is locked out but kept for audit.
export const UserStatus = z.enum(['active', 'pending', 'suspended'])
export type UserStatus = z.infer<typeof UserStatus>

// How an unknown-but-domain-matching identity is treated. Defaults to
// `open_domain` (current behaviour) so existing deploys don't change.
export const AccessPolicy = z.enum(['open_domain', 'request', 'invite'])
export type AccessPolicy = z.infer<typeof AccessPolicy>

// ----- invites -----------------------------------------------------------

export const Invite = z.object({
  id: z.string(),
  email: z.string(),
  invitedBy: z.string().nullable(),
  invitedByEmail: z.string().nullable(),
  createdAt: z.number().int(),
  redeemedAt: z.number().int().nullable(),
  redeemedUser: z.string().nullable()
})
export type Invite = z.infer<typeof Invite>

// POST accepts a single address or a pasted bulk list (comma / whitespace /
// newline separated). The server normalises + dedupes; this carries the raw
// blob so the client doesn't have to pre-split.
export const CreateInvitesRequest = z.object({
  emails: z.string().min(1).max(20_000)
})
export type CreateInvitesRequest = z.infer<typeof CreateInvitesRequest>

export const CreateInvitesResponse = z.object({
  added: z.number().int().min(0),
  // Already-invited or already-a-user addresses we skipped.
  skipped: z.number().int().min(0),
  // Entries that didn't look like an email.
  invalid: z.array(z.string())
})
export type CreateInvitesResponse = z.infer<typeof CreateInvitesResponse>

// ----- join codes --------------------------------------------------------

export const JoinCodeRedeem = z.enum(['active', 'pending'])
export type JoinCodeRedeem = z.infer<typeof JoinCodeRedeem>

export const JoinCode = z.object({
  id: z.string(),
  label: z.string(),
  // Bare domain (e.g. `visma.com`); only matching emails may redeem.
  domainRestrict: z.string().nullable(),
  onRedeem: JoinCodeRedeem,
  maxUses: z.number().int().nullable(),
  uses: z.number().int().min(0),
  expiresAt: z.number().int().nullable(),
  createdBy: z.string().nullable(),
  createdByEmail: z.string().nullable(),
  createdAt: z.number().int(),
  revokedAt: z.number().int().nullable()
})
export type JoinCode = z.infer<typeof JoinCode>

export const CreateJoinCodeRequest = z.object({
  label: z.string().max(120).optional(),
  // A bare domain. A leading `@` is tolerated + stripped server-side.
  domainRestrict: z
    .string()
    .max(253)
    .nullish()
    .transform((v) => (v ? v.trim().replace(/^@/, '').toLowerCase() : null)),
  onRedeem: JoinCodeRedeem.default('active'),
  maxUses: z.number().int().positive().max(100_000).nullish(),
  expiresInDays: z.number().int().positive().max(365).nullish()
})
export type CreateJoinCodeRequest = z.infer<typeof CreateJoinCodeRequest>

// The plaintext `code` is returned EXACTLY ONCE on creation and never
// again — the table stores only its SHA-256 hash.
export const CreateJoinCodeResponse = z.object({
  joinCode: JoinCode,
  code: z.string()
})
export type CreateJoinCodeResponse = z.infer<typeof CreateJoinCodeResponse>
