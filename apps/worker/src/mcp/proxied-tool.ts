/**
 * What a proxied upstream tool looks like to the agent, and the one sanctioned
 * augmentation of its result — shared by both lanes so a tool reads the same
 * whichever lane lists it.
 *
 * Everything upstream-supplied that passes through here is untrusted model
 * input: descriptions are control-char stripped + provenance-defanged
 * (`sanitizeUntrustedText`) before anything first-party is appended.
 */

import type { UpstreamConnection } from '../db/queries/upstreams'
import type { UpstreamToolRow } from '../db/queries/upstream-tools'
import { truncateDescription } from './catalogue-views'
import { firstParty, sanitizeUntrustedText } from './provenance'

/**
 * The agent-facing description of a proxied tool: the upstream's own blurb
 * (sanitised, prefixed with the upstream's display name), plus — when the
 * org attached playbooks to this specific tool — a first-party pointer line.
 */
export function proxiedToolDescription(
  conn: Pick<UpstreamConnection, 'displayName'>,
  row: Pick<UpstreamToolRow, 'description'>,
  pointers: string[] = []
): string {
  // Upstream-supplied descriptions are untrusted model input. Strip
  // control characters (which can hide injected instructions or
  // disrupt agent rendering) before forwarding. We deliberately do
  // NOT try to detect prompt-injection content — that's the model's
  // job; ours is to keep the wire bytes well-formed.
  const description = truncateDescription(
    sanitizeUntrustedText(`[${conn.displayName}] ${row.description ?? ''}`)
  )
  if (pointers.length === 0) return description
  // Append org-curated per-tool attachment pointers. These are
  // first-party (slug strings we control), not upstream input, so they
  // need no sanitisation. Truncate the base description first to
  // reserve room — the pointer is the binding guidance and must
  // survive the 1024-char cap even when the upstream blurb is long.
  //
  // Descriptive disclosure, NOT an imperative: name the org playbooks that
  // exist for this tool and leave the choice to the agent. The old
  // "consult X before using this tool" framing was a command smuggled
  // through the data plane — well-behaved agents (correctly) treat tool
  // metadata as untrusted and resist it, so it was both brittle and
  // eroding of the very boundary that protects callers from a malicious
  // upstream's descriptions. The structured home for these is
  // `describe_upstream` (per-tool `attached_skills`/`attached_docs`); this
  // line is just passive discoverability on the one field every client
  // renders. Wrapped in the ⟦ctxlayer⟧ provenance marker (first-party,
  // unforgeable — the upstream description above it is defanged).
  const suffix = `\n\n${firstParty(`Related org playbooks (optional context): ${pointers.join(', ')}.`)}`
  return truncateDescription(description, 1024 - suffix.length) + suffix
}

/** The cached JSON Schema for a tool's arguments; `{}` for a bad cache row. */
export function cachedInputSchema(row: Pick<UpstreamToolRow, 'input_schema'>): unknown {
  try {
    return JSON.parse(row.input_schema)
  } catch {
    // Bad cache row; treat as no schema. Tool still callable.
    return {}
  }
}

/**
 * Append a first-result playbook hint to a success surface as ONE extra
 * first-party text item. Called AFTER the runner (so after its sanitise
 * pass) — the deliberate, bounded exception to "success results are never
 * augmented"; the append site is outside the runner precisely so the
 * ⟦ctxlayer⟧ marker survives without a sanitiser carve-out. Hint bytes never
 * enter respJson (usage stays honest). Design: docs/plan/O-result-skill-hint.md.
 *
 * The hinted result also OMITS `structuredContent`: clients render the
 * structured value INSTEAD of the content array when both are present
 * (field-verified 2026-08-27 — the hint survived every server layer
 * including an SDK round-trip yet never reached the model on Driver/
 * Sentry, whose results carry structuredContent), which would make the
 * hint invisible on exactly the upstreams it was built for. The text
 * item carries the identical JSON, so the model loses nothing; only
 * this one result loses structured output.
 *
 * Whether a hint is due (once per upstream per session / per client window)
 * is each lane's decision; this is only the surface transform.
 */
export function withFirstResultHint<
  T extends { content: Array<{ type: string; text?: string }>; structuredContent?: unknown }
>(surface: T, hint: string): T {
  const { structuredContent: _omitted, ...rest } = surface
  return {
    ...rest,
    content: [...surface.content, { type: 'text', text: hint }]
  } as T
}
