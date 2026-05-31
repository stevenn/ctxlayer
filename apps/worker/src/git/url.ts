/**
 * Base-URL resolution + runtime trust-boundary check for git providers.
 *
 * The admin REST handler validates the configured base URL with the
 * `GitBaseUrl` Zod refine (https-only, not a workers host). This module
 * re-asserts https at the dial site (defense in depth — the runtime's
 * `global_fetch_strictly_public` flag already blocks RFC1918 egress) and
 * derives the API + web hosts per provider.
 */

const HTTP_LOOPBACK_RE = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i

/** Throw unless the URL is https (or a dev loopback http URL). */
export function assertSafeFetchUrl(url: string): void {
  const ok = url.toLowerCase().startsWith('https://') || HTTP_LOOPBACK_RE.test(url)
  if (!ok) throw new Error('git: refusing to fetch a non-https url')
}

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, '')
}

/**
 * GitHub REST API base. NULL ⇒ public github.com (api.github.com).
 * For GitHub Enterprise the configured base is the instance root; its
 * API lives under `/api/v3`.
 */
export function githubApiBase(baseUrl: string | null): string {
  if (!baseUrl) return 'https://api.github.com'
  const root = stripTrailingSlash(baseUrl)
  return /\/api\/v3$/.test(root) ? root : `${root}/api/v3`
}

/** GitHub web base for building file deep-links (blob URLs). */
export function githubWebBase(baseUrl: string | null): string {
  if (!baseUrl) return 'https://github.com'
  // Enterprise instance root doubles as the web host.
  return stripTrailingSlash(baseUrl).replace(/\/api\/v3$/, '')
}
