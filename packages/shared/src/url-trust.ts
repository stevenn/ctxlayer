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

/**
 * Our own Cloudflare hosts. Registering one as an upstream/git target would
 * let the proxy loop back into itself, so they're rejected at the boundary.
 * (The runtime's `global_fetch_strictly_public` flag blocks RFC 1918 +
 * link-local egress; this guard closes the self-loop hole it doesn't cover.)
 */
export function isOwnWorkersHost(u: string): boolean {
  const h = hostOf(u)
  return h !== '' && (h.endsWith('workers.dev') || h.endsWith('cloudflareworkers.com'))
}
