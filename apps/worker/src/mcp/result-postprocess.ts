/**
 * Registry of post-processors for upstream isError tool results. Each
 * entry is gated on UPSTREAM IDENTITY (URL host) before its text
 * matcher ever runs — a bare regex like /single sign-?on/ must not fire
 * a GitHub-branded playbook (with a GitHub error code) on a Datadog or
 * Notion error that happens to use the same phrase.
 *
 * Runs INSIDE `runUpstreamCall`, before the sanitiser and the size cap
 * (nudge text is first-party ⟦ctxlayer⟧-marked; sanitising it would
 * strip the marker). This is also the intended landing spot for the
 * July-review §1a decision (a narrow credential-shape scrub on isError
 * passthrough) — add it as another processor, not as an inline branch
 * in the runner.
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
