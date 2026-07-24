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
 * GitHub returns SAML-SSO refusals as a tool RESULT error (`isError: true`
 * content), not a thrown one — so it bypasses `sanitiseUpstreamError` and the
 * raw "Resource protected by organization SAML enforcement" text would reach
 * the agent verbatim. Detect that specific signature and substitute a
 * first-party, actionable playbook telling the caller exactly how to SSO-link
 * their token. Because it REPLACES the upstream content, it also closes the
 * one error path that forwarded upstream text unsanitised.
 *
 * Returns null when the message isn't a SAML-SSO refusal (caller then leaves
 * the normal error surface untouched). The org, when parsable from a
 * github.com URL in the message, is validated against GitHub's org-slug
 * charset before being interpolated into a URL we construct — the message is
 * never echoed back; only the extracted, constrained slug is.
 */
export function samlSsoNudge(raw: string, slug: string): string | null {
  if (!raw) return null
  // Conservative: only unambiguous SAML-SSO refusal phrasings.
  if (
    !/resource protected by organization saml|saml sso|saml enforcement|saml single sign-?on|grant your (?:oauth |personal access )?token access to this organization|single sign-?on/i.test(
      raw
    )
  ) {
    return null
  }
  const org = extractGithubOrg(raw)
  const orgLabel = org ? `"${org}"` : 'the GitHub organization'
  const orgPossessive = org ? `${org}'s` : "the org's"
  const ssoUrl = org
    ? `https://github.com/orgs/${org}/sso`
    : 'https://github.com/orgs/<your-org>/sso'
  return (
    `[ctxlayer] This GitHub call was blocked because org ${orgLabel} enforces SAML ` +
    `single sign-on and your GitHub authorization is not SSO-linked to it. Your token ` +
    `still works for your own repos — only ${orgPossessive} resources are affected.\n\n` +
    `To fix (per-user, one-time):\n` +
    `1. Open ${ssoUrl} and complete single sign-on to authorize your token for the org.\n` +
    `2. Re-run the tool. If it still fails, reconnect the ${slug} connector in ctxlayer ` +
    `at /app/upstreams (find GitHub → "Reconnect") so a fresh token is minted during the ` +
    `active SAML session.\n` +
    `3. If GitHub does not re-prompt on reconnect (an existing grant is cached), first ` +
    `revoke it at GitHub → Settings → Applications → Authorized OAuth Apps, then reconnect.`
  )
}

// GitHub org slugs: 1–39 chars, alphanumeric or hyphen, must start
// alphanumeric. Constrained enough to safely drop into a URL we build.
const GITHUB_ORG_RE = /github\.com\/(?:repos|orgs)\/([A-Za-z0-9][A-Za-z0-9-]{0,38})/i

function extractGithubOrg(raw: string): string | null {
  return GITHUB_ORG_RE.exec(raw)?.[1] ?? null
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
      // biome-ignore lint/suspicious/noControlCharactersInRegex: deliberately matches control chars to strip them
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
