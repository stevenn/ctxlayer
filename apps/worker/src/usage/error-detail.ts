/**
 * Classify + scrub tool-call failures for the usage error table.
 *
 * Two outputs land on the raw `usage_events` row (status <> 'ok' only):
 *   - error_code: a coarse, filterable class — `timeout`, the HTTP
 *     families, `upstream_auth`, `upstream_unreachable`, a generic
 *     `upstream_error`, or `local_error` for built-in/ctxlayer-side
 *     failures.
 *   - error_message: the root detail, CREDENTIAL-scrubbed but with
 *     host / IP / URL deliberately KEPT — those are the actionable bits
 *     an operator (or the user whose own call failed) wants without
 *     opening Cloudflare observability.
 *
 * This is intentionally a DIFFERENT redaction profile from
 * `mcp/upstream-error.ts:sanitiseUpstreamError`, which also strips
 * URLs/IPs because its output is echoed back to the *agent*. Here the
 * audience is the usage UI: admins see org-wide rows; the per-user
 * `/api/usage` is self-scoped, so a host/IP only ever reflects the
 * viewer's own call. Credentials are scrubbed in BOTH paths — we never
 * store a secret at rest.
 */

export type UsageErrorCode =
  | 'timeout'
  | 'upstream_5xx'
  | 'upstream_4xx'
  | 'upstream_auth'
  | 'upstream_unreachable'
  | 'upstream_error'
  | 'local_error'

const MAX_LEN = 200

/**
 * Map a failed upstream call to a coarse class. `status` is the usage
 * status the proxy already decided (`timeout` when our own deadline
 * fired). For an `error` we sniff the raw message for the strongest
 * signal, most-specific first:
 *   - auth before the generic 4xx so a 401/403 isn't swallowed by it;
 *   - explicit transport signals (ECONNREFUSED, fetch failed, …) before
 *     the HTTP-number heuristics, because the loose `\b4\d{2}\b` / `\b5\d{2}\b`
 *     also match port numbers / ids in a connection error (e.g. the `443`
 *     in `ECONNREFUSED 10.0.0.1:443`).
 * Heuristic by nature — the class is coarse on purpose.
 */
export function classifyUpstreamError(status: 'error' | 'timeout', raw: string): UsageErrorCode {
  if (status === 'timeout') return 'timeout'
  const m = raw.toLowerCase()
  if (
    /\b(?:401|403)\b|unauthor|forbidden|invalid[_ -]?grant|invalid[_ -]?token|token (?:has )?expired|expired token/.test(
      m
    )
  )
    return 'upstream_auth'
  if (
    /econnrefused|econnreset|enotfound|eai_again|etimedout|\bdns\b|connection (?:refused|reset|closed|failed)|network error|socket hang|fetch failed|unreachable/.test(
      m
    )
  )
    return 'upstream_unreachable'
  if (/\b5\d{2}\b|internal server error|bad gateway|service unavailable|gateway time-?out/.test(m))
    return 'upstream_5xx'
  if (
    /\b4\d{2}\b|bad request|not found|method not allowed|unprocessable|conflict|too many requests|rate.?limit/.test(
      m
    )
  )
    return 'upstream_4xx'
  return 'upstream_error'
}

/**
 * Credential-scrub a raw error for storage. Strips control chars + the
 * same credential shapes `sanitiseUpstreamError` does, but deliberately
 * KEEPS URLs / IPs / hostnames (operator-useful) and only trims noise +
 * length-caps. Node stack frames are dropped — they rarely carry the
 * root cause and eat the cap.
 */
export function scrubErrorForStorage(raw: string): string {
  if (!raw) return ''
  return (
    raw
      // Control chars (incl. ANSI escapes' ESC byte).
      // biome-ignore lint/suspicious/noControlCharactersInRegex: deliberately matches control chars to strip them
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '')
      // Bearer / Authorization headers as they appear in error bodies.
      .replace(/\bAuthorization\s*[:=]\s*\S+/gi, 'Authorization: [redacted]')
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
      // Common API-key prefixes + generic key=/token=/secret= forms.
      .replace(
        /\b(?:sk|pk|tok|api[-_]?key|key|token|secret)[=:_\- ][A-Za-z0-9._~+/=-]{8,}/gi,
        '[redacted]'
      )
      // Node-style stack frames (noise; host/IP/URL are kept above).
      .replace(/\s+at\s+[^\s)]+\s*\([^)]*\)/g, '')
      .replace(/\s+at\s+\S+/g, '')
      // Collapse remaining whitespace + cap length.
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_LEN)
  )
}

/**
 * Pull a readable message out of an MCP tool result's `content` array
 * (the `isError: true` path), falling back to a compact JSON of whatever
 * was there. Keeps the stored detail human-readable instead of a
 * `[{"type":"text",...}]` wrapper.
 */
export function errorTextFromContent(content: unknown): string {
  if (Array.isArray(content)) {
    const texts = content
      .filter(
        (c): c is { type: string; text: string } =>
          !!c &&
          typeof c === 'object' &&
          (c as { type?: unknown }).type === 'text' &&
          typeof (c as { text?: unknown }).text === 'string'
      )
      .map((c) => c.text)
    if (texts.length) return texts.join(' ')
  }
  try {
    return typeof content === 'string' ? content : JSON.stringify(content ?? '')
  } catch {
    return ''
  }
}
