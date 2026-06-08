/**
 * Request + response shapes for the upstream-proxy REST surface (M4).
 *
 * - Admin endpoints (CRUD on upstream_servers + visibility) live under
 *   `/api/admin/upstreams/*`.
 * - User endpoints (visible list + paste-bearer credentials) live under
 *   `/api/upstreams/*`.
 *
 * A stdio MCP server is supported via the bring-your-own-bridge model: the
 * operator runs a stdio<->HTTP bridge and registers the resulting HTTP URL
 * as a normal `streamable_http` upstream. There is therefore no dedicated
 * stdio transport.
 */
import { z } from 'zod'
import { AuthStrategy, UpstreamAuthConfig } from './upstream-auth-strategy'
import { VisibilityScopeKind } from './org-ia'
import { prefixedSlug } from './slug'
import { isHttpsOrLoopback } from './url-trust'

// Remote HTTP transports are the only dialable kinds; admin POST/PATCH
// validate against this set. Matches `UpstreamTransport` from mcp-types.
export const SupportedTransport = z.enum(['streamable_http', 'sse'])
export type SupportedTransport = z.infer<typeof SupportedTransport>

// Slug rules for an upstream: matches MCP tool-name allowed alphabet
// (`[a-zA-Z0-9_-]`) but stricter (lowercase + leading letter) so it
// stays readable when used as the `${slug}__${tool}` prefix. Dashes are
// allowed — the entity-prefix convention emits `up-<body>`, and the
// read shape must accept what `prefixedSlug('upstream')` produces (a
// dash-free regex here silently broke the admin list once the first
// prefixed upstream was created).
export const UpstreamSlug = z
  .string()
  .min(1)
  .max(24)
  .regex(/^[a-z][a-z0-9_-]*$/, 'lowercase letter, then letters/digits/dashes/underscores (≤24)')

const ReservedSlugs = new Set([
  'list_upstreams',
  'search_docs',
  'get_doc',
  'whoami',
  'list_my_context'
])

/**
 * Outbound upstream URLs must be https in production (http allowed only
 * for loopback in dev). The self-loop guard — rejecting ctxlayer's OWN
 * deployment host so the proxy can't call back into itself — is enforced
 * SERVER-SIDE in the admin handler (it needs `PUBLIC_BASE_URL`, which this
 * env-less shared schema can't see; see `isSameOrigin` in `url-trust.ts`).
 * Private-range egress is additionally blocked at the fetch layer by the
 * runtime's `global_fetch_strictly_public` flag (set in wrangler.toml).
 */
export const UpstreamUrl = z
  .string()
  .url()
  .refine(isHttpsOrLoopback, 'must be https (http allowed only for localhost)')

export const CreateUpstreamRequest = z.object({
  // `up-` prefix enforced on new upstreams; it rides into every proxied
  // tool name (`up-<slug-body>__<tool>`). The base `UpstreamSlug` stays
  // permissive for read shapes so pre-prefix upstreams keep validating.
  slug: prefixedSlug('upstream').refine(
    (s) => !ReservedSlugs.has(s),
    'slug collides with a built-in tool'
  ),
  displayName: z.string().min(1).max(120),
  transport: SupportedTransport,
  url: UpstreamUrl,
  authStrategy: AuthStrategy,
  authConfig: UpstreamAuthConfig.optional(),
  enabled: z.boolean().optional()
})
export type CreateUpstreamRequest = z.infer<typeof CreateUpstreamRequest>

export const UpdateUpstreamRequest = z.object({
  displayName: z.string().min(1).max(120).optional(),
  transport: SupportedTransport.optional(),
  url: UpstreamUrl.optional(),
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
  // True iff the upstream has a `shared_bearer` cred stored. Always
  // false for non-shared_bearer upstreams. Drives the admin drawer
  // shared-bearer section.
  sharedCredentialConfigured: z.boolean(),
  // True iff a static-OAuth client secret is sealed on this upstream. The
  // secret itself is never returned; this flag drives the "secret set"
  // placeholder in the OAuth-client form. False for DCR / public clients.
  clientSecretConfigured: z.boolean().default(false),
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

// Skill / doc references that surface on the upstream and per-tool
// rows when M7a attachments are present. `slug` is the SKILL.md /
// doc slug (the URL-safe id); `name` / `title` is the human display
// label rendered next to the chip. Both arrays default to empty.
export const AttachedSkillRef = z.object({
  slug: z.string(),
  title: z.string()
})
export type AttachedSkillRef = z.infer<typeof AttachedSkillRef>

export const AttachedDocRef = z.object({
  slug: z.string(),
  title: z.string()
})
export type AttachedDocRef = z.infer<typeof AttachedDocRef>

// One cached tool as exposed to the admin tool-browser. Surfaces the
// upstream-side name (the real one called over the wire), the
// description shown to agents, and the parsed input schema. The
// mangled namespaced name agents actually see is derived client-side
// via the same `mangleToolName` rule the worker uses, so we don't
// duplicate that logic in the response.
export const UpstreamToolSummary = z.object({
  toolName: z.string(),
  description: z.string().nullable(),
  inputSchema: z.unknown(),
  cachedAt: z.number().int(),
  // M8: timestamp of the last detected input_schema change; null if
  // never changed (or pre-migration row). Drives the stale annotation
  // on per-tool rows alongside attached_skills.
  lastSchemaChangeAt: z.number().int().nullable().optional(),
  lastDiffSummary: z.string().nullable().optional(),
  // M7a additions; empty arrays when no attachments exist.
  attachedSkills: z.array(AttachedSkillRef).default([]),
  attachedDocs: z.array(AttachedDocRef).default([])
})
export type UpstreamToolSummary = z.infer<typeof UpstreamToolSummary>

export const UpstreamToolsResponse = z.object({
  upstreamId: z.string(),
  slug: UpstreamSlug,
  tools: z.array(UpstreamToolSummary),
  // Whole-upstream attachments (tool_name='' rows in skill_attachments
  // / doc_attachments). Surface on the upstream row itself, not on any
  // specific tool. Empty arrays when no attachments exist.
  attachedSkills: z.array(AttachedSkillRef).default([]),
  attachedDocs: z.array(AttachedDocRef).default([])
})
export type UpstreamToolsResponse = z.infer<typeof UpstreamToolsResponse>
