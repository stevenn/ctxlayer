/**
 * Catching the one thing a provider will occasionally tell us about its own
 * authorization lifetime: `refresh_token_expires_in` on a token response.
 *
 * It is not standard — RFC 6749 never defines a refresh-token lifetime — so
 * it is sent by some providers (GitHub Apps, Entra in places) and not others.
 * Worse, it never reached us even when sent: the MCP SDK parses token
 * responses with a schema that ends in `.strip()`, so every field outside
 * access_token / id_token / token_type / expires_in / scope / refresh_token
 * was dropped before `saveTokens` ran. Hence the fetch wrapper: on the DCR
 * path the SDK owns the POST, and `auth(..., { fetchFn })` is the only seam
 * where the raw body is still intact. The static path parses its own JSON and
 * calls `parseRefreshExpiry` directly.
 *
 * Nothing here can fail a token exchange: a malformed or absent value just
 * means we fall back to a measured or configured lifetime.
 */

/** Ignore values past this — a decade out is a bug or a sentinel, not a date. */
const MAX_PLAUSIBLE_SECONDS = 10 * 365 * 86400

/**
 * Absolute expiry (unix seconds) from a token-response body, or null when the
 * provider said nothing usable. Pure.
 *
 * Reads `refresh_token_expires_in` (seconds from now, the de-facto field) and
 * `refresh_token_expires_at` (absolute, seen on a few providers). Numeric
 * strings are accepted because form-encoded providers send them that way.
 */
export function parseRefreshExpiry(body: unknown, nowSec: number): number | null {
  if (!body || typeof body !== 'object') return null
  const rec = body as Record<string, unknown>
  const relative = numeric(rec.refresh_token_expires_in)
  if (relative !== null && relative > 0 && relative <= MAX_PLAUSIBLE_SECONDS) {
    return nowSec + Math.floor(relative)
  }
  const absolute = numeric(rec.refresh_token_expires_at)
  if (absolute !== null && absolute > nowSec && absolute <= nowSec + MAX_PLAUSIBLE_SECONDS) {
    return Math.floor(absolute)
  }
  return null
}

function numeric(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/**
 * Wrap a fetch so token-endpoint responses are read for a refresh expiry on
 * their way past, without disturbing the caller.
 *
 * The body is cloned before parsing — the SDK still consumes the original —
 * and every failure mode (non-JSON, a body that cannot be cloned, a throwing
 * parse) is swallowed: this is opportunistic enrichment sitting in the middle
 * of the login path.
 */
export function captureRefreshExpiry(
  onExpiry: (expiresAt: number) => void,
  baseFetch: typeof fetch = fetch
): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const res = await baseFetch(input as RequestInfo, init)
    // Only a successful POST carries tokens; anything else cannot carry an
    // expiry we would believe.
    if (!res.ok || (init?.method ?? 'GET').toUpperCase() !== 'POST') return res
    try {
      const body = await res.clone().json()
      const expiresAt = parseRefreshExpiry(body, Math.floor(Date.now() / 1000))
      if (expiresAt) onExpiry(expiresAt)
    } catch {
      // Not JSON, already-consumed, or unparseable — nothing to learn.
    }
    return res
  }
}
