/**
 * Request + response shapes for the upstream-proxy REST surface (M4).
 *
 * - Admin endpoints (CRUD on upstream_servers + visibility) live under
 *   `/api/admin/upstreams/*`.
 * - User endpoints (visible list + paste-bearer credentials) live under
 *   `/api/upstreams/*`.
 *
 * `stdio_daytona` is intentionally absent from `UpstreamTransport` until
 * the Daytona track ships — see docs/plan/B-daytona-stdio.md.
 */
import { z } from 'zod'
import { AuthStrategy, UpstreamAuthConfig } from './upstream-auth-strategy'
import { VisibilityScopeKind } from './org-ia'

// The wider `UpstreamTransport` from mcp-types still includes
// `stdio_daytona` for the `list_upstreams()` MCP tool result shape.
// At the REST request layer we narrow to what M4 actually supports;
// admin POST/PATCH validate against this narrower set.
export const SupportedTransport = z.enum(['streamable_http', 'sse'])
export type SupportedTransport = z.infer<typeof SupportedTransport>

// Slug rules for an upstream: matches MCP tool-name allowed alphabet
// (`[a-zA-Z0-9_-]`) but stricter (lowercase + leading letter) so it
// stays readable when used as the `${slug}__${tool}` prefix.
export const UpstreamSlug = z
  .string()
  .min(1)
  .max(24)
  .regex(/^[a-z][a-z0-9_]*$/, 'lowercase letter, then letters/digits/underscores (≤24)')

const ReservedSlugs = new Set(['list_upstreams', 'search_docs', 'get_doc', 'whoami', 'list_my_context'])

export const CreateUpstreamRequest = z.object({
  slug: UpstreamSlug.refine((s) => !ReservedSlugs.has(s), 'slug collides with a built-in tool'),
  displayName: z.string().min(1).max(120),
  transport: SupportedTransport,
  url: z.string().url(),
  authStrategy: AuthStrategy,
  authConfig: UpstreamAuthConfig.optional(),
  enabled: z.boolean().optional()
})
export type CreateUpstreamRequest = z.infer<typeof CreateUpstreamRequest>

export const UpdateUpstreamRequest = z.object({
  displayName: z.string().min(1).max(120).optional(),
  transport: SupportedTransport.optional(),
  url: z.string().url().optional(),
  authStrategy: AuthStrategy.optional(),
  authConfig: UpstreamAuthConfig.optional(),
  enabled: z.boolean().optional()
})
export type UpdateUpstreamRequest = z.infer<typeof UpdateUpstreamRequest>

// Visibility PUT: replace the entire rule set for one upstream.
export const VisibilityRulePayload = z.object({
  scopeKind: VisibilityScopeKind,
  scopeId: z.string().nullable()
})
export type VisibilityRulePayload = z.infer<typeof VisibilityRulePayload>

export const ReplaceVisibilityRequest = z.object({
  rules: z.array(VisibilityRulePayload)
})
export type ReplaceVisibilityRequest = z.infer<typeof ReplaceVisibilityRequest>

// Paste-bearer creds. OAuth credentials land via `/api/upstreams/:id/oauth/*`
// in M5 — not modeled here.
export const PasteBearerRequest = z.object({
  token: z.string().min(1).max(8192)
})
export type PasteBearerRequest = z.infer<typeof PasteBearerRequest>

// ----- Read-side shapes -------------------------------------------------

// Admin-facing row: full record, no decrypted secrets.
//
// `currentUserConnected` reflects whether the calling admin has stored
// credentials for this upstream. Drives the connection badge + button
// state in the admin drawer. For `none`-strategy upstreams it's always
// true (no creds needed).
export const AdminUpstreamRow = z.object({
  id: z.string(),
  slug: UpstreamSlug,
  displayName: z.string(),
  transport: SupportedTransport,
  url: z.string().url(),
  authStrategy: AuthStrategy,
  authConfig: UpstreamAuthConfig,
  enabled: z.boolean(),
  visibility: z.array(VisibilityRulePayload),
  toolsCount: z.number().int().min(0),
  toolsCachedAt: z.number().int().nullable(),
  currentUserConnected: z.boolean(),
  createdAt: z.number().int(),
  updatedAt: z.number().int()
})
export type AdminUpstreamRow = z.infer<typeof AdminUpstreamRow>

// User-facing summary: what /upstreams page renders.
// `requiresCredentials` drives the SPA into "paste bearer" vs
// "no setup needed" branches; `connected` reflects whether the caller
// has stored credentials (always true for `none`/`shared_bearer`).
export const UserUpstreamSummary = z.object({
  id: z.string(),
  slug: UpstreamSlug,
  displayName: z.string(),
  transport: SupportedTransport,
  authStrategy: AuthStrategy,
  requiresCredentials: z.boolean(),
  connected: z.boolean(),
  toolsCount: z.number().int().min(0)
})
export type UserUpstreamSummary = z.infer<typeof UserUpstreamSummary>

// Catalogue refresh response (admin-triggered).
export const RefreshToolsResponse = z.object({
  upstreamId: z.string(),
  slug: UpstreamSlug,
  toolsCount: z.number().int().min(0),
  cachedAt: z.number().int()
})
export type RefreshToolsResponse = z.infer<typeof RefreshToolsResponse>

