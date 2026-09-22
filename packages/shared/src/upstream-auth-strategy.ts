import { z } from 'zod'
import { isHttpsOrLoopback } from './url-trust'

export const AuthStrategy = z.enum(['none', 'shared_bearer', 'user_bearer', 'user_oauth'])
export type AuthStrategy = z.infer<typeof AuthStrategy>

const HttpAuthConfig = z.object({
  headerName: z.string().default('Authorization'),
  headerPrefix: z.string().default('Bearer '),
  // Static headers sent alongside the sealed credential. For upstreams whose
  // auth is not one header: a Cloudflare Access service token wants
  // `CF-Access-Client-Id` AND `CF-Access-Client-Secret`, so the id lives here
  // (an identifier, shown in the CF dashboard indefinitely) while the secret
  // rides the sealed shared-token slot under `headerName`. Non-secret config —
  // this column is not encrypted, so never put a credential here. The auth
  // header is applied last and cannot be shadowed by these.
  extraHeaders: z.record(z.string(), z.string()).optional()
})

// OAuth config supports two shapes that share the same JSON column:
//   - DCR (default): the worker registers via RFC 7591 against the upstream's
//     discovered authorization server and persists the response under
//     `client_info`. All other fields are optional.
//   - Pre-registered (future, admin-configured): supply `authorizeUrl` +
//     `tokenUrl` + `clientId` (+ optional sealed `clientSecretCiphertext`)
//     to skip discovery / DCR.
//
// `client_info` mirrors the SDK's `OAuthClientInformationFull` shape. Held
// here as a loose record so we don't pull SDK types into the shared package.
// Same trust boundary as the git static-OAuth config: the user's
// authorization code, refresh token, and the sealed client secret travel
// to these endpoints — https only (loopback http allowed for local dev).
const OAuthEndpointUrl = z
  .url()
  .refine(isHttpsOrLoopback, { error: 'must be https' })

const OauthAuthConfig = z
  .looseObject({
    authorizeUrl: OAuthEndpointUrl.optional(),
    tokenUrl: OAuthEndpointUrl.optional(),
    scopes: z.array(z.string()).optional(),
    clientId: z.string().optional(),
    clientSecretCiphertext: z.string().optional(),
    // Write-only input from the admin form. The admin handler SEALS this
    // into `clientSecretCiphertext` and STRIPS it before persisting — it is
    // never stored plaintext and never returned on read. Present in the
    // schema only so the form's PATCH/POST body validates.
    clientSecret: z.string().optional(),
    // NOTE: `client_id` / `client_secret` used to be declared here too, as a
    // flat mirror of what DCR returned. Nothing read them and the secret copy
    // duplicated a plaintext credential, so the write is gone
    // (`upstream/oauth-provider.ts`). This stays a loose object, so rows that
    // still carry the pair parse fine — and `redactOAuthSecrets` still strips
    // it — until their next registration rewrites them away. Don't add them
    // back: `client_info` is the whole registration.
    client_info: z.record(z.string(), z.unknown()).optional()
  })

// Per-upstream resilience overrides. All optional — absent fields fall
// back to the module-level defaults in `upstream/http-client.ts`. Stored
// in the same `auth_config` JSON column, so no DB migration is needed.
// Values are milliseconds. The admin REST handler clamps them to a hard
// ceiling at the trust boundary (one slow upstream blocks the serial
// McpSessionDO, so an unbounded override would freeze the whole session).
const UpstreamTimeouts = z.object({
  // Base inactivity window per tools/call (silent-upstream wall clock).
  callMs: z.number().int().positive().optional(),
  // Absolute ceiling per tools/call regardless of progress pings.
  maxCallMs: z.number().int().positive().optional(),
  // Fail-fast cap for tools/list.
  listMs: z.number().int().positive().optional()
})
export type UpstreamTimeouts = z.infer<typeof UpstreamTimeouts>

export const UpstreamAuthConfig = z.object({
  http: HttpAuthConfig.optional(),
  oauth: OauthAuthConfig.optional(),
  timeouts: UpstreamTimeouts.optional(),
  // Per-upstream response-size cap in bytes (overrides the global
  // default). Oversized tools/call results degrade to a truncation
  // notice rather than nuking the agent's context.
  maxResponseBytes: z.number().int().positive().optional(),
  // Native tool names that must run async (submit→poll) instead of inline.
  // A 2-3 min tool (e.g. Driver's `gather_task_context`) exceeds interactive
  // client request caps (Claude Desktop ~180s); listing it here makes the
  // proxy enqueue a job + return a token, and the ctxlayer-jobs consumer runs
  // the real call. See docs/plan/I-upstream-resilience.md §I9.
  asyncTools: z.array(z.string()).optional(),
  // user_oauth only, and the LAST resort of three (see `resolveGrantExpiry`):
  // what an admin believes this provider's absolute authorization lifetime is,
  // counted from the moment the user authorized and not extended by refreshes
  // (observed 2026-09: Datadog 14, Linear ~25, Sentry 30). A provider that
  // reports its own expiry wins, then ctxlayer's own measurements; this is the
  // bootstrap for upstreams that do neither, and the seed before enough
  // deaths have been observed. Leave unset for providers without a hard cap.
  grantLifetimeDays: z.number().int().min(1).max(365).optional()
})
export type UpstreamAuthConfig = z.infer<typeof UpstreamAuthConfig>

/** Warn this many days before an upstream authorization's absolute expiry. */
export const GRANT_EXPIRY_WARN_DAYS = 3

/**
 * Where the expiry number came from, worst-to-best:
 *  - `configured`: an admin typed `grantLifetimeDays`. A guess by a human.
 *  - `observed`: ctxlayer measured it — the median lifetime of this
 *    upstream's grants that have actually died here.
 *  - `provider`: the upstream itself said so (`refresh_token_expires_in` on
 *    a token response). Authoritative; nothing overrides it.
 * Surfaced so the countdown can say "expires" when we were told and
 * "expires about" when we inferred.
 */
export const GrantExpirySource = z.enum(['provider', 'observed', 'configured'])
export type GrantExpirySource = z.infer<typeof GrantExpirySource>

export interface GrantExpiry {
  /** Unix seconds at which the provider is expected to drop the grant. */
  expiresAt: number
  /** Whole days left, floored; 0 on the last day, negative once past. */
  daysLeft: number
  /** Within GRANT_EXPIRY_WARN_DAYS of expiry (or already past it). */
  expiringSoon: boolean
  source: GrantExpirySource
}

export interface GrantExpiryInputs {
  /** Absolute expiry the provider reported, unix seconds. Wins outright. */
  providerExpiresAt?: number | null
  /** When the current authorization was granted (migration 0036). */
  grantedAt?: number | null
  /** Median measured lifetime for this upstream, whole days. */
  observedDays?: number | null
  /** Admin-configured `authConfig.grantLifetimeDays`. */
  configuredDays?: number | null
}

/**
 * Predicted absolute expiry of one user's upstream authorization, or null
 * when nothing can say. Pure — shared so the agent-facing `list_upstreams`
 * and the SPA Upstreams page compute the same answer the same way.
 *
 * Precedence is provider → observed → configured, because that is the order
 * of how much the number is worth. OAuth has no standard field for "when
 * does this authorization die" (RFC 6749 never defines a refresh-token
 * lifetime), so most providers cannot tell us even when they know — the
 * `workers-oauth-provider` servers behind several upstreams hold an exact
 * `expiresAt` and put nothing about it on the wire. Hence the fallbacks.
 *
 * A provider that slides its window reports a constant remaining lifetime,
 * which correctly reads as "no cliff"; one with an absolute cap reports a
 * shrinking one. Both are handled by taking it at face value.
 */
export function resolveGrantExpiry(
  inputs: GrantExpiryInputs,
  nowSec: number
): GrantExpiry | null {
  const at = (expiresAt: number, source: GrantExpirySource): GrantExpiry => ({
    expiresAt,
    daysLeft: Math.floor((expiresAt - nowSec) / 86400),
    expiringSoon: Math.floor((expiresAt - nowSec) / 86400) < GRANT_EXPIRY_WARN_DAYS,
    source
  })
  if (inputs.providerExpiresAt) return at(inputs.providerExpiresAt, 'provider')
  if (!inputs.grantedAt) return null
  if (inputs.observedDays) return at(inputs.grantedAt + inputs.observedDays * 86400, 'observed')
  if (inputs.configuredDays) return at(inputs.grantedAt + inputs.configuredDays * 86400, 'configured')
  return null
}

/** Below this many measured deaths, an upstream's own history says nothing. */
export const MIN_GRANT_OBSERVATIONS = 3

/**
 * The measured lifetime of an upstream's authorizations, in whole days, from
 * however many deaths we have on record — or null while that is too few to
 * mean anything.
 *
 * Median, not min: a user who disconnects an upstream by hand on day 2 logs a
 * 2-day "lifetime", and a minimum would then warn everybody every day
 * forever. Floored, so the warning fires a little early rather than a little
 * late. Real providers cluster tightly enough for this to be precise (field
 * data 2026-09: 14.1–14.8d, 24.94–25.02d, 30.0d), and a policy change shows
 * up as the new deaths outvote the old ones.
 */
export function observedGrantDays(lifetimeDays: readonly number[]): number | null {
  if (lifetimeDays.length < MIN_GRANT_OBSERVATIONS) return null
  const sorted = [...lifetimeDays].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const median =
    sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? 0)
  const days = Math.floor(median)
  return days >= 1 ? days : null
}

/**
 * A `user_oauth` upstream runs in "pre-registered / static" mode — skip RFC
 * 9728 discovery + RFC 7591 DCR and use admin-supplied endpoints — when it
 * carries an explicit `clientId` + `authorizeUrl` + `tokenUrl`. This is the
 * path for identity providers that don't support DCR (e.g. Microsoft Entra
 * ID, which fronts the Azure DevOps MCP). Absent those, `user_oauth` stays in
 * the default DCR mode driven by the MCP SDK's `auth()` orchestrator.
 */
export function isStaticOAuthConfig(cfg: UpstreamAuthConfig | undefined | null): boolean {
  const o = cfg?.oauth
  return Boolean(o?.clientId && o?.authorizeUrl && o?.tokenUrl)
}
