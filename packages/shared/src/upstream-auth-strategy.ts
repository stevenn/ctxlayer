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
    client_id: z.string().optional(),
    client_secret: z.string().optional(),
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
  // user_oauth only. How many days this provider lets one authorization
  // live, counted from the moment the user authorized — an ABSOLUTE cap that
  // token refreshes do not extend (observed 2026-09: Datadog 14, Linear ~25,
  // Sentry 30; both of the latter run workers-oauth-provider, whose
  // refresh-token TTL is stamped once at the code exchange). Drives the
  // "expires in N days" warning on list_upstreams + /app/upstreams so users
  // renew before the cliff. Leave unset for providers without a hard cap.
  grantLifetimeDays: z.number().int().min(1).max(365).optional()
})
export type UpstreamAuthConfig = z.infer<typeof UpstreamAuthConfig>

/** Warn this many days before an upstream authorization's absolute expiry. */
export const GRANT_EXPIRY_WARN_DAYS = 3

export interface GrantExpiry {
  /** Unix seconds at which the provider is expected to drop the grant. */
  expiresAt: number
  /** Whole days left, floored; 0 on the last day, negative once past. */
  daysLeft: number
  /** Within GRANT_EXPIRY_WARN_DAYS of expiry (or already past it). */
  expiringSoon: boolean
}

/**
 * Predicted absolute expiry of one user's upstream authorization, or null
 * when it can't be known (no configured lifetime, or no grant stamp). Pure —
 * shared so the agent-facing `list_upstreams` and the SPA Upstreams page
 * compute the same answer from the same two inputs.
 */
export function grantExpiry(
  grantedAt: number | null | undefined,
  grantLifetimeDays: number | null | undefined,
  nowSec: number
): GrantExpiry | null {
  if (!grantedAt || !grantLifetimeDays) return null
  const expiresAt = grantedAt + grantLifetimeDays * 86400
  const daysLeft = Math.floor((expiresAt - nowSec) / 86400)
  return { expiresAt, daysLeft, expiringSoon: daysLeft < GRANT_EXPIRY_WARN_DAYS }
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
