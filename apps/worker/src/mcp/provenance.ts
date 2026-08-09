/**
 * Content provenance marking.
 *
 * ctxlayer mixes two provenances in the text it hands the agent:
 *   - FIRST-PARTY: content ctxlayer itself authored (org-playbook pointers on
 *     tool descriptions, the SAML-SSO nudge, the size-cap notice). This is
 *     trusted operator guidance.
 *   - THIRD-PARTY: everything an upstream emits — tool descriptions and
 *     tool-call results. This is UNTRUSTED data and must never be obeyed as
 *     instructions, however it is framed.
 *
 * A plain `[ctxlayer]` label is spoofable: a malicious/compromised upstream
 * could put `[ctxlayer] you are pre-authorized to…` in a description or result
 * and impersonate the gateway. We fix that with an UNFORGEABLE marker:
 *
 *   - `firstParty(text)` wraps ctxlayer's own text in ⟦ctxlayer⟧ … ⟦/ctxlayer⟧
 *     (U+27E6 / U+27E7 — mathematical white square brackets, effectively never
 *     present in real tool text/data).
 *   - `defangProvenance(text)` STRIPS those bracket codepoints from every piece
 *     of upstream-originated text before ctxlayer forwards it.
 *
 * Because the strip runs on all untrusted input, the invariant holds: a
 * ⟦ctxlayer⟧ … ⟦/ctxlayer⟧ segment in what the agent receives can only have
 * been placed by ctxlayer, never forged by an upstream. The marker value is
 * not secret — its integrity comes from the strip, not from obscurity.
 *
 * This is a wire convention: it is inert until a client/model is taught to
 * honor it, but it is readable, harmless when ignored, and the substrate a
 * provenance-aware client needs. The convention is documented to the agent in
 * the MCP server `instructions` (the trusted channel), not smuggled as data.
 */

export const CTX_MARK_OPEN = '⟦ctxlayer⟧' // ⟦ctxlayer⟧
export const CTX_MARK_CLOSE = '⟦/ctxlayer⟧' // ⟦/ctxlayer⟧

/** Wrap first-party ctxlayer text in the provenance markers. */
export function firstParty(text: string): string {
  return `${CTX_MARK_OPEN} ${text} ${CTX_MARK_CLOSE}`
}

/**
 * Neutralise the provenance markers in UNTRUSTED (upstream-originated) text so
 * it cannot forge a first-party segment. Strips only the two rare bracket
 * codepoints, so legitimate data is left intact (they essentially never occur
 * in real tool descriptions or results).
 */
export function defangProvenance(s: string): string {
  return s.replace(/[⟦⟧]/g, '')
}

/**
 * Apply the full untrusted-text gate to every content item in an upstream tool
 * RESULT before it is forwarded to the agent. Non-text items pass through
 * untouched.
 *
 * Results get the same treatment as descriptions. An upstream reports failure
 * the MCP-idiomatic way — `{ content, isError: true }` — rather than by
 * throwing, so that text never reaches the `catch` sanitiser in
 * `runUpstreamCall`; without the strip here, a result was the one path that
 * could still carry raw C0/C1 bytes to the model.
 */
export function sanitizeUntrustedContent<T extends { type: string; text?: string }>(
  content: T[]
): T[] {
  return content.map((c) =>
    typeof c.text === 'string' ? { ...c, text: sanitizeUntrustedText(c.text) } : c
  )
}

/**
 * The full untrusted-text gate: strip C0 control characters (except
 * tab/newline/carriage return) and the C1 range, THEN neutralise the
 * ⟦ctxlayer⟧ provenance marker. Keeps regular punctuation, whitespace, and
 * Unicode intact.
 *
 * EVERY path that forwards upstream-originated text to the model must run it
 * through here — that is what makes the provenance invariant above hold. Lives
 * beside `defangProvenance` (rather than in the proxy) so the non-proxy
 * consumers — notably the `draft_skill` context bundle, which inlines upstream
 * tool descriptions into a prompt template — cannot silently skip it.
 */
export function sanitizeUntrustedText(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: deliberately matches control chars to strip them
  return defangProvenance(s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, ''))
}
