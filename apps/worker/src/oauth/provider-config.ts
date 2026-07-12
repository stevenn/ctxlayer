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
import type { OAuthProviderOptions } from '@cloudflare/workers-oauth-provider'
import { McpSessionDO } from '../mcp/session-do'
import type { Env } from '../env'

const NOOP_HANDLER: ExportedHandler<Env> = {
  fetch: () => new Response('not used by admin helpers', { status: 500 })
}

export function oauthProviderOptions(
  defaultHandler: ExportedHandler<Env> = NOOP_HANDLER
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
    scopesSupported: ['mcp']
  }
}
