/**
 * Registry of post-processors for upstream isError tool results. Each
 * entry is gated on UPSTREAM IDENTITY (URL host) before its text
 * matcher ever runs — a bare regex like /single sign-?on/ must not fire
 * a GitHub-branded playbook (with a GitHub error code) on a Datadog or
 * Notion error that happens to use the same phrase.
 *
 * Runs INSIDE `runUpstreamCall`, before the sanitiser and the size cap
 * (nudge text is first-party ⟦ctxlayer⟧-marked; sanitising it would
 * strip the marker).
 *
 * This module also owns the July-review §1a scrub (`scrubErrorContent`):
 * isError result text is deliberately forwarded to the agent (tool errors
 * are functionally necessary diagnostics), but credential SHAPES in it —
 * Authorization header echoes, bearer blobs, JWTs, well-known vendor token
 * prefixes — are redacted first. Unlike the processors above it is not
 * identity-gated (a leaked credential is a leaked credential regardless of
 * which upstream echoed it) and it transforms rather than replaces, so its
 * output stays on the normal sanitise path. Deliberately narrow: hostnames,
 * paths and status text pass through untouched so diagnostics stay useful.
 */

import type { UsageErrorCode } from '@ctxlayer/shared'
import { githubOrgAccessNudge } from './github-nudges'

/** Identity of the upstream a result came from, for the appliesTo gate. */
export interface UpstreamRef {
  slug: string
  /** The upstream's registered URL; absent only in defensive callers. */
  url?: string
}

export interface ErrorResultRewrite {
  text: string
  errorCode: UsageErrorCode
}

interface ErrorResultProcessor {
  name: string
  appliesTo(ref: UpstreamRef): boolean
  process(raw: string, ref: UpstreamRef): ErrorResultRewrite | null
}

/** True when the upstream URL points at GitHub's API/MCP surface. */
function isGithubHost(url: string | undefined): boolean {
  if (!url) return false
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }
  return (
    host === 'github.com' ||
    host.endsWith('.github.com') ||
    host === 'githubcopilot.com' ||
    host.endsWith('.githubcopilot.com')
  )
}

const PROCESSORS: ErrorResultProcessor[] = [
  {
    name: 'github-org-access',
    appliesTo: (ref) => isGithubHost(ref.url),
    process: (raw, ref) => githubOrgAccessNudge(raw, ref.slug)
  }
]

/**
 * Run the registered processors for this upstream, most-specific first;
 * the first rewrite wins. Returns null when no processor applies or
 * matches — the caller keeps the (sanitised) original result.
 */
export function postProcessErrorResult(ref: UpstreamRef, raw: string): ErrorResultRewrite | null {
  for (const p of PROCESSORS) {
    if (!p.appliesTo(ref)) continue
    const rewrite = p.process(raw, ref)
    if (rewrite) return rewrite
  }
  return null
}

/**
 * Credential shapes redacted from isError result text (July review §1a).
 * High-precision on purpose: every pattern anchors on either an auth
 * keyword or a vendor prefix plus a long token blob, so ordinary error
 * prose ("token expired", "bearer of…") can't match. Broadening any of
 * these risks blunting genuinely useful upstream diagnostics — the
 * review explicitly weighed and rejected an aggressive scrub.
 */
const CREDENTIAL_SHAPES: RegExp[] = [
  // `Authorization: Bearer <anything>` header echoes (any scheme value length —
  // the header name itself marks the value as a credential).
  /\bauthorization\s*[:=]\s*(?:bearer|basic|token)\s+[^\s"'`,;]+/gi,
  // Bare `Bearer <long-blob>` / `token <long-blob>` outside a header echo.
  /\b(?:bearer|token)\s+[A-Za-z0-9\-._~+/]{20,}=*/gi,
  // JWT triplet (header.payload.signature).
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // Vendor-prefixed tokens: GitHub, Slack, OpenAI-style sk-, AWS access key id.
  /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g
]

/** Redact credential shapes from one string. Exported for tests. */
export function scrubCredentialShapes(text: string): string {
  let out = text
  for (const re of CREDENTIAL_SHAPES) out = out.replace(re, '[redacted-credential]')
  return out
}

/**
 * Scrub an isError result's `content` before ANYTHING downstream reads it —
 * the agent-facing surface, usage `respJson`/`error_detail`, and the
 * async_jobs row `poll_task` replays all derive from the return value, so
 * this is the single write site. Handles the MCP-idiomatic error shapes
 * (text-item array, bare string); other shapes pass through to the normal
 * sanitise path unchanged. Never applied to non-error results: a legitimate
 * tool result may contain secret-shaped data the caller asked to read.
 */
export function scrubErrorContent(content: unknown): unknown {
  if (typeof content === 'string') return scrubCredentialShapes(content)
  if (Array.isArray(content)) {
    return content.map((item) =>
      item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string'
        ? { ...item, text: scrubCredentialShapes((item as { text: string }).text) }
        : item
    )
  }
  return content
}
