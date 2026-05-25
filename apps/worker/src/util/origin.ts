/**
 * Origin comparison shared by `requireCsrf` and the `/collab/:docId`
 * WS upgrade. In prod the rule is strict: the Origin header must
 * equal `env.PUBLIC_BASE_URL` exactly. In local dev that's too strict:
 * Vite serves the SPA from `:5173` and proxies to wrangler on `:8787`,
 * but the browser's `Origin` header carries `:5173` while
 * `PUBLIC_BASE_URL` is `:8787`. We allow any `https?://localhost:*`
 * Origin when `PUBLIC_BASE_URL` itself is a localhost URL — i.e.,
 * only in dev. Production deployments never have a localhost
 * `PUBLIC_BASE_URL`, so the prod check stays byte-exact.
 */

export function isAllowedOrigin(origin: string | null, publicBaseUrl: string): boolean {
  if (!origin) return false
  if (origin === publicBaseUrl) return true
  if (!isLocalhostUrl(publicBaseUrl)) return false
  return isLocalhostUrl(origin)
}

function isLocalhostUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
  } catch {
    return false
  }
}
