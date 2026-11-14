/**
 * Root-path aliases for the OAuth endpoints.
 *
 * Our endpoints live under `/oauth/*` and are advertised in the
 * authorization-server metadata. Claude's hosted connector, however, falls
 * back to the pre-discovery default endpoints of the 2025-03-26 MCP auth spec
 * — `<mcp-origin>/token`, `/register`, `/authorize` — when a refresh or a
 * discovery fetch fails transiently, and then never re-runs discovery: it
 * keeps posting to the default path until the user reconnects by hand
 * (anthropics/claude-ai-mcp#1169, reproduced by several operators). One blip
 * on our side would otherwise strand a connector on `POST /token` → 405.
 *
 * So the default paths answer exactly like the advertised ones: the request
 * is re-addressed in place (no redirect — a 30x on a token POST is not
 * something to bet a client on) before it reaches the OAuth provider.
 *
 * The three paths must also be in `run_worker_first` (wrangler.toml), or the
 * asset resolver answers them with the SPA shell / a 405 first.
 */

const ALIASES: Readonly<Record<string, string>> = {
  '/token': '/oauth/token',
  '/register': '/oauth/register',
  '/authorize': '/oauth/authorize'
}

/**
 * The request to hand to the OAuth provider: the same request re-addressed to
 * the advertised endpoint when it targets a default path, otherwise the
 * request itself (identity, so callers can skip work when nothing changed).
 */
export function aliasDefaultOAuthEndpoint(req: Request): Request {
  const url = new URL(req.url)
  const target = ALIASES[url.pathname]
  if (!target) return req
  url.pathname = target
  return new Request(url.toString(), req)
}
