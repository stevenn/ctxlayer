/**
 * Helpers for surfacing upstream MCP-tool errors to the calling agent
 * without leaking sensitive details. CLAUDE.md / the 2026-05-26 security
 * pass mandates: never echo upstream error messages verbatim — they can
 * carry API keys, bearer tokens, internal hostnames, stack frames.
 *
 * Strategy (per "A+B" in the H follow-up):
 *   A. Generate a short correlation id per call so admins can grep the
 *      full server log when an operator complains.
 *   B. Sanitise + length-cap the upstream message so the user gets an
 *      *actionable* hint (HTTP status, generic timeout text) without
 *      anything that could leak credentials or topology.
 */

export interface UpstreamErrorFormat {
  /** User-facing one-liner returned via MCP `errText`. */
  userMessage: string
  /** Same correlation id as the one written to the server log. */
  refId: string
}

/**
 * 8 hex chars — short enough to read off a screen, unique-enough for
 * a single worker invocation. Not a security token; just a haystack
 * pointer the operator quotes to whoever has log access.
 */
export function newCorrelationId(): string {
  return crypto.randomUUID().slice(0, 8)
}

export function formatUpstreamError(args: {
  slug: string
  toolName: string
  status: 'timeout' | 'error'
  rawMessage: string
  refId?: string
}): UpstreamErrorFormat {
  const code = args.status === 'timeout' ? 'upstream_timeout' : 'upstream_error'
  const refId = args.refId ?? newCorrelationId()
  const sanitised = sanitiseUpstreamError(args.rawMessage)
  const tail = sanitised ? ` — ${sanitised}` : ''
  return {
    userMessage: `${code}: ${args.slug}.${args.toolName}${tail} (ref=${refId})`,
    refId
  }
}

/**
 * Strip the patterns most likely to leak secrets / internal topology
 * from an upstream MCP error message, then length-cap so a chatty
 * upstream can't bloat the model's context.
 *
 * Order matters — narrow patterns (Bearer, Authorization, sk_…) run
 * before the broader URL strip so the credential gets redacted as a
 * recognised token rather than disappearing inside a URL replacement.
 *
 * Conservative by design — when in doubt, drop. The operator can ask
 * an admin to grep the server log via the `ref=` id for full detail.
 */
export function sanitiseUpstreamError(raw: string): string {
  if (!raw) return ''
  return (
    raw
      // Control chars (incl. ANSI escapes' ESC byte). Keeps the
      // payload safe to forward to the model as plain text.
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '')
      // Bearer / Authorization headers as they often appear in
      // upstream error bodies.
      .replace(/\bAuthorization\s*[:=]\s*\S+/gi, 'Authorization: [redacted]')
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
      // Common API-key prefixes (Stripe, OpenAI, etc.) and generic
      // `key=…`, `token=…`, `api[_-]?key=…` formats.
      .replace(
        /\b(?:sk|pk|tok|api[-_]?key|key|token|secret)[=:_\- ][A-Za-z0-9._~+/=-]{8,}/gi,
        '[redacted]'
      )
      // URLs (after credentials so a `https://user:pass@…` token gets
      // redacted by the pattern above first).
      .replace(/https?:\/\/\S+/g, '[url]')
      // IPs (IPv4 + a permissive IPv6 form that also catches `::`
      // compressed runs like `2001:db8::1`).
      .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, '[ip]')
      .replace(/\b[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){2,7}\b/gi, '[ip]')
      // Node-style stack frames.
      .replace(/\s+at\s+[^\s)]+\s*\([^)]*\)/g, '')
      .replace(/\s+at\s+\S+/g, '')
      // Collapse remaining whitespace + cap length.
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200)
  )
}
