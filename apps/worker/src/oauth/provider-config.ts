/**
 * Single source of truth for the OAuthProvider config.
 *
 * `index.ts` constructs the live provider; admin tooling (e.g. the
 * OAuth-clients viewer) constructs a read-only `OAuthHelpers` instance
 * via `getOAuthApi(opts, env)` and MUST use the identical KV+path
 * config so the helpers point at the same data the live provider
 * wrote. Extracted here so we can't drift.
 *
 * The `defaultHandler` is plumbed through as a parameter because
 * helpers paths (listClients, lookupClient, etc.) never invoke it —
 * admin code can pass a stub, while `index.ts` passes the real Hono
 * app.
 */

import type { ExportedHandler } from '@cloudflare/workers-types'
import type {
  OAuthProviderOptions,
  TokenExchangeCallbackOptions
} from '@cloudflare/workers-oauth-provider'
import { McpSessionDO } from '../mcp/session-do'
import type { Env } from '../env'
import { stampTokenExchange } from './login-activity'

const NOOP_HANDLER: ExportedHandler<Env> = {
  fetch: () => new Response('not used by admin helpers', { status: 500 })
}

/**
 * A login lasts as long as it keeps refreshing (see oauth/login-activity.ts).
 *
 * Both TTLs below are passed as `undefined` on purpose — the library then
 * writes the grant and the DCR client record to KV with NO expiration, and
 * expiry becomes ours to decide. That is the only way to get a sliding
 * session out of this library: `refreshTokenTTL` is stamped once, at the
 * authorization-code exchange, and the refresh path re-saves the same
 * absolute instant (it even refuses a `refreshTokenTTL` returned from the
 * token-exchange callback). `clientRegistrationTTL` behaves the same way
 * from the registration moment, so leaving it at its 90 d default would cap
 * the login independently — the final refresh would just fail
 * `invalid_client` instead of `invalid_grant`.
 *
 * What replaces them: `tokenExchangeCallback` stamps every exchange into
 * `oauth_grant_activity`, and the nightly `grant-idle-prune` job revokes
 * grants that have been silent for `MCP_LOGIN_IDLE_DAYS`. Instant lockout is
 * unaffected — suspend/delete still calls `revokeAllUserGrants`, and the
 * session DO re-checks user status on init.
 *
 * `env` is optional because admin tooling builds `OAuthHelpers` from these
 * same options (see the module header) and never exchanges a token; without
 * it the callback is simply not installed.
 */
export function oauthProviderOptions(
  defaultHandler: ExportedHandler<Env> = NOOP_HANDLER,
  env?: Env
): OAuthProviderOptions<Env> {
  // apiHandlers requires ExportedHandlerWithFetch (Required fetch);
  // our handlers carry `fetch` at the value level but their declared
  // types don't line up exactly, so the whole map is cast once.
  const apiHandlers = {
    '/mcp': McpSessionDO.serve('/mcp', { binding: 'MCP_SESSION_DO' }),
    '/sse': McpSessionDO.serveSSE('/sse', { binding: 'MCP_SESSION_DO' })
  } as OAuthProviderOptions<Env>['apiHandlers']
  return {
    apiHandlers,
    defaultHandler,
    authorizeEndpoint: '/oauth/authorize',
    tokenEndpoint: '/oauth/token',
    clientRegistrationEndpoint: '/oauth/register',
    // Explicit `undefined` — it overrides the library defaults (30 d / 90 d)
    // through the options spread, and is what makes the KV records
    // expiration-less. See the note above before "simplifying" these away.
    refreshTokenTTL: undefined,
    clientRegistrationTTL: undefined,
    ...(env
      ? {
          tokenExchangeCallback: (opts: TokenExchangeCallbackOptions) =>
            stampTokenExchange(env, opts)
        }
      : {}),
    scopesSupported: ['mcp']
  }
}
