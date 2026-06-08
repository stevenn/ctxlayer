import { z } from 'zod'

export const AuthStrategy = z.enum(['none', 'shared_bearer', 'user_bearer', 'user_oauth'])
export type AuthStrategy = z.infer<typeof AuthStrategy>

const HttpAuthConfig = z.object({
  headerName: z.string().default('Authorization'),
  headerPrefix: z.string().default('Bearer ')
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
const OauthAuthConfig = z
  .object({
    authorizeUrl: z.string().url().optional(),
    tokenUrl: z.string().url().optional(),
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
  .passthrough()

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
  maxResponseBytes: z.number().int().positive().optional()
})
export type UpstreamAuthConfig = z.infer<typeof UpstreamAuthConfig>

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
