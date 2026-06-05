/**
 * Trust-boundary helpers for admin-settable *outbound* URLs (upstream
 * proxy targets, git base URLs). Centralises the rules that both
 * `upstream-api.ts` and `git-api.ts` enforce so they can't drift apart.
 *
 * Avoids the DOM/Node `URL` global — the shared package targets ES2023
 * with no `lib.dom`, so parsing is done with small regexes after Zod's
 * `.url()` has already validated overall syntax.
 */

// http is allowed only when the host is a literal loopback address — keeps
// the local-dev story (point at a localhost MCP server) without softening
// the prod https rule.
const HTTP_LOOPBACK_RE = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i

export function isHttpsOrLoopback(u: string): boolean {
  return u.toLowerCase().startsWith('https://') || HTTP_LOOPBACK_RE.test(u)
}

/** Lowercased hostname, sans userinfo/port, without the DOM `URL` global. */
export function hostOf(u: string): string {
  const m = u.match(/^[a-z]+:\/\/([^/?#]+)/i)
  if (!m || !m[1]) return ''
  let host = m[1]
  const at = host.lastIndexOf('@')
  if (at >= 0) host = host.slice(at + 1)
  const colon = host.indexOf(':')
  if (colon >= 0) host = host.slice(0, colon)
  return host.toLowerCase()
}

/** Host + normalized port (scheme default filled in), sans userinfo. */
function authorityOf(u: string): { host: string; port: string } {
  const host = hostOf(u)
  if (host === '') return { host: '', port: '' }
  const m = u.match(/^([a-z]+):\/\/([^/?#]+)/i)
  const scheme = (m?.[1] ?? '').toLowerCase()
  let authority = m?.[2] ?? ''
  const at = authority.lastIndexOf('@')
  if (at >= 0) authority = authority.slice(at + 1)
  const colon = authority.indexOf(':')
  const explicitPort = colon >= 0 ? authority.slice(colon + 1) : ''
  const port = explicitPort || (scheme === 'http' ? '80' : '443')
  return { host, port }
}

/**
 * True when two URLs share the same origin authority (host + normalized
 * port). The self-loop guard: an admin must not register ctxlayer's own
 * deployment (`PUBLIC_BASE_URL`) as an upstream / git base, or the proxy
 * loops back into itself. Enforced SERVER-SIDE in the admin REST handler
 * because only the worker knows its own `PUBLIC_BASE_URL` — the shared
 * Zod schema can't see env, which is why the old TLD-wide heuristic
 * wrongly blocked every other Cloudflare-hosted MCP. Port-aware so a dev
 * MCP on a different localhost port is NOT mistaken for the dev server.
 * (The runtime's `global_fetch_strictly_public` flag covers RFC 1918 +
 * link-local egress; this closes the self-loop hole it doesn't.)
 */
export function isSameOrigin(a: string, b: string): boolean {
  const x = authorityOf(a)
  const y = authorityOf(b)
  return x.host !== '' && x.host === y.host && x.port === y.port
}
