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
 * So the default paths answer like the advertised ones. The two machine
 * endpoints are re-addressed in place before the request reaches the OAuth
 * provider (no redirect — a 30x on a token POST is not something to bet a
 * client on). `/authorize` is a browser navigation and IS redirected: a
 * deployment may gate `/oauth/authorize` at the edge (Cloudflare Access
 * asserting the user's identity), and serving the page in place from the
 * ungated root path would skip that gate and leave the user on a consent
 * page with no way to approve.
 *
 * The three paths must also be in `run_worker_first` (wrangler.toml), or the
 * asset resolver answers them with the SPA shell / a 405 first.
 */

/** Machine endpoints: served in place under the advertised path. */
const REWRITES: Readonly<Record<string, string>> = {
  '/token': '/oauth/token',
  '/register': '/oauth/register'
}

/** Browser endpoints: redirected, so edge gates on the real path still apply. */
const REDIRECTS: Readonly<Record<string, string>> = {
  '/authorize': '/oauth/authorize'
}

/**
 * What to do with a request before the OAuth provider sees it:
 * - a `Response` to return as-is (the `/authorize` redirect, query preserved);
 * - the request re-addressed to the advertised endpoint (`/token`, `/register`);
 * - or the request itself, untouched (identity) for every other path.
 */
export function aliasDefaultOAuthEndpoint(req: Request): Request | Response {
  const url = new URL(req.url)
  const redirect = REDIRECTS[url.pathname]
  if (redirect) {
    url.pathname = redirect
    return new Response(null, {
      status: 302,
      headers: { location: url.toString(), 'cache-control': 'no-store' }
    })
  }
  const rewrite = REWRITES[url.pathname]
  if (!rewrite) return req
  url.pathname = rewrite
  return new Request(url.toString(), req)
}
