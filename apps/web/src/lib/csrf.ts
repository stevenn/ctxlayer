/**
 * Reads the __Host-ctx_csrf cookie value the worker sets at sign-in
 * (see apps/worker/src/auth/csrf.ts). The token is not HttpOnly so
 * JS can read it and echo it as the X-CSRF header on unsafe requests
 * — the standard double-submit cookie pattern.
 *
 * Returns undefined when the cookie is missing (user signed out, or
 * signed in before PR1 landed). The api helper turns that into a
 * 403 from the server, which redirects the SPA to /sign-in.
 */
export function readCsrfToken(): string | undefined {
  const target = '__Host-ctx_csrf='
  for (const part of document.cookie.split(/;\s*/)) {
    if (part.startsWith(target)) return part.slice(target.length)
  }
  return undefined
}
