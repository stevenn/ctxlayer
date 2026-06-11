/**
 * Request/response schemas for the `/api/*` REST surface.
 *
 * SCOPE: `/api/*` is an INTERNAL contract for the bundled React SPA — it is
 * not a versioned, stable public API, and may change without notice between
 * releases. External integrators should use the MCP surface (`/mcp`, `/sse`)
 * and the OAuth provider, which are the supported, discoverable contracts.
 */
import { z } from 'zod'
import { AccessPolicy } from './entitlement'

// Known roles; we keep the enum closed because role drives admin gating.
// Adding a role is a deliberate schema migration.
export const Role = z.enum(['user', 'admin'])
export type Role = z.infer<typeof Role>

// Identity providers. Known IdPs are validated strictly; unknown values
// fall through as `z.string()` so adding an OIDC provider in M5 doesn't
// break existing clients that haven't redeployed.
export const KnownIdp = z.enum(['google', 'github'])
export type KnownIdp = z.infer<typeof KnownIdp>
export const Idp = z.union([KnownIdp, z.string()])
export type Idp = z.infer<typeof Idp>

export const HealthResponse = z.object({
  ok: z.boolean(),
  version: z.string(),
  builtAt: z.string(),
  dependencies: z.array(
    z.object({
      name: z.string(),
      ok: z.boolean(),
      latencyMs: z.number().optional(),
      error: z.string().optional()
    })
  )
})
export type HealthResponse = z.infer<typeof HealthResponse>

// `.nullish()` so that the Worker can either send `null` or omit the
// field entirely (JSON.stringify drops undefined). The previous
// `.nullable()` rejected payloads that omitted the key and caused the
// SPA to bounce to /sign-in on any user without a display name.
export const MeResponse = z.object({
  id: z.string(),
  // GitHub allows users with no public email; accept any non-empty
  // string. The actual email-shape validation happens server-side at
  // sign-in time.
  email: z.string().min(1),
  name: z.string().nullish(),
  avatarUrl: z.string().nullish(),
  role: Role,
  idp: Idp,
  lastSeenAt: z.number().nullish()
})
export type MeResponse = z.infer<typeof MeResponse>

export const VersionResponse = z.object({
  gitSha: z.string(),
  builtAt: z.string()
})
export type VersionResponse = z.infer<typeof VersionResponse>

// `/api/config` — public, drives SPA sign-in UI.
export const ConfigResponse = z.object({
  idps: z.array(KnownIdp),
  publicBaseUrl: z.string(),
  // Admission policy. The sign-in page shows a join-code input when this
  // is `invite`. `.catch` keeps an older SPA bundle working if the field
  // is ever absent.
  accessPolicy: AccessPolicy.catch('open_domain')
})
export type ConfigResponse = z.infer<typeof ConfigResponse>
