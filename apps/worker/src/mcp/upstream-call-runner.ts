/**
 * The live upstream `tools/call` runner: response-size guardrail,
 * untrusted-text sanitisation, error classification, and the progress
 * heartbeat. Shared by the inline proxy handler (`proxy-registry.ts`)
 * and the async background runner (`queues/jobs-consumer.ts`) so the
 * two paths can't drift.
 */

import {
  firstParty,
  sanitizeUntrustedContent,
  sanitizeUntrustedStructured,
  sanitizeUntrustedText
} from './provenance'
import { formatUpstreamError, newCorrelationId } from './upstream-error'
import { postProcessErrorResult, scrubErrorContent } from './result-postprocess'
import { classifyUpstreamError, errorTextFromContent } from '../usage/error-detail'
import { byteLength } from '../usage/tokens'
import { UPSTREAM_MAX_RESPONSE_BYTES } from '../upstream/http-client'
import { errMessage } from '../util/errors'
import { safeJson } from './tool-result'

export function isTimeoutError(err: unknown): boolean {
  const msg = errMessage(err)
  // Both the upstream/http-client 60s wall cap and the MCP SDK's
  // own RequestTimeoutError surface as messages mentioning timeout.
  return /timeout|timed out|deadline/i.test(msg)
}

/** Normalised result of a single upstream `tools/call` — surface + usage meta. */
export interface UpstreamCallOutcome {
  /** The agent-facing tool result (or, in the consumer, the value to persist). */
  surface: {
    isError: boolean
    content: Array<{ type: string; text?: string }>
    structuredContent?: Record<string, unknown>
  }
  /** Response string recorded for usage (the truncation notice when capped). */
  respJson: string
  status: 'ok' | 'error' | 'timeout'
  truncated: boolean
  errorCode?: string
  errorDetail?: string
}

/**
 * Run one upstream `tools/call` and normalise the result: apply the
 * response-size guardrail (WI-4), classify errors, and sanitise any raw
 * error message before it reaches the agent (never echo upstream errors
 * verbatim — they can carry API keys / hostnames / stack frames). Total —
 * never throws; a failed call surfaces as an `errText`-style `isError` result
 * with `status: 'error' | 'timeout'`.
 *
 * The caller supplies `run` so the inline path can wrap it in the progress
 * heartbeat while the consumer calls the client directly.
 */
export async function runUpstreamCall(opts: {
  slug: string
  toolName: string
  /** The upstream's registered URL — gates identity-keyed post-processors. */
  upstreamUrl?: string
  maxResponseBytes?: number
  run: () => Promise<{ content: unknown; isError?: boolean; structuredContent?: unknown }>
}): Promise<UpstreamCallOutcome> {
  try {
    const result = await opts.run()
    // §1a (2026-07 review): isError text IS forwarded to the agent (and
    // stored + replayed via async_jobs.error_detail / usage), so credential
    // shapes are redacted here — the one write site every downstream reader
    // derives from. Non-error results are never scrubbed: a legitimate
    // result may carry secret-shaped data the caller asked to read.
    const content = result.isError ? scrubErrorContent(result.content) : result.content
    let respJson = safeJson(content ?? null)
    let status: 'ok' | 'error' | 'timeout' = 'ok'
    let errorCode: string | undefined
    let errorDetail: string | undefined
    if (result.isError) {
      status = 'error'
      errorDetail = errorTextFromContent(content)
      errorCode = classifyUpstreamError('error', errorDetail)
      // Recognised access refusals (e.g. GitHub SAML SSO / IP allow list /
      // OAuth-app restriction) arrive as tool-result content (not a thrown
      // error), so they skip the sanitiser in the catch below and would reach
      // the agent verbatim. The registry swaps the recognised ones — gated on
      // upstream identity, never on text alone — for a first-party, actionable
      // playbook and tags a distinct code so the usage Errors table separates
      // them from the generic 4xx bucket (and doubles as the "who's blocked on
      // what" list).
      const rewrite = postProcessErrorResult({ slug: opts.slug, url: opts.upstreamUrl }, errorDetail)
      if (rewrite) {
        return {
          surface: { isError: true, content: [{ type: 'text', text: rewrite.text }] },
          respJson,
          status,
          truncated: false,
          errorCode: rewrite.errorCode,
          errorDetail
        }
      }
    }
    // structuredContent is upstream output too: count its bytes toward the
    // relay cap and usage accounting alongside content (it used to bypass
    // both), and run it through the deep untrusted-value gate below.
    const structJson =
      result.structuredContent === undefined ? null : safeJson(result.structuredContent)
    if (structJson) respJson = `${respJson}\n${structJson}`
    const respBytes = byteLength(respJson)
    const cap = opts.maxResponseBytes ?? UPSTREAM_MAX_RESPONSE_BYTES
    // No isError exemption: a hostile upstream can flood the context with a
    // giant "error" just as easily as with a giant result. The recognised
    // nudge classes returned above, before this cap, and stay intact.
    if (respBytes > cap) {
      const notice = truncationNotice(opts.slug, opts.toolName, respBytes, cap)
      respJson = notice
      return {
        surface: { isError: !!result.isError, content: [{ type: 'text', text: notice }] },
        respJson,
        status,
        truncated: true,
        errorCode,
        errorDetail
      }
    }
    return {
      surface: {
        isError: !!result.isError,
        // Strip control chars + neutralise the ⟦ctxlayer⟧ marker in
        // upstream-originated result text, so a tool result can neither forge a
        // first-party directive nor smuggle terminal/C1 bytes to the model.
        content: Array.isArray(content)
          ? sanitizeUntrustedContent(content as Array<{ type: string; text?: string }>)
          : [
              {
                type: 'text',
                text: sanitizeUntrustedText(JSON.stringify(content ?? null, null, 2))
              }
            ],
        structuredContent:
          result.structuredContent === undefined
            ? undefined
            : (sanitizeUntrustedStructured(result.structuredContent) as Record<string, unknown>)
      },
      respJson,
      status,
      truncated: false,
      errorCode,
      errorDetail
    }
  } catch (err) {
    const status: 'error' | 'timeout' = isTimeoutError(err) ? 'timeout' : 'error'
    const msg = errMessage(err)
    const refId = newCorrelationId()
    console.error(`[upstream-proxy] [ref=${refId}] ${opts.slug}.${opts.toolName} ${status}: ${msg}`)
    const { userMessage } = formatUpstreamError({
      slug: opts.slug,
      toolName: opts.toolName,
      status,
      rawMessage: msg,
      refId
    })
    return {
      surface: { isError: true, content: [{ type: 'text', text: userMessage }] },
      respJson: msg,
      status,
      truncated: false,
      errorCode: classifyUpstreamError(status, msg),
      errorDetail: msg
    }
  }
}

/** Emit a heartbeat progress ping roughly this often during a long call. */
const HEARTBEAT_MS = 25_000

/**
 * The slice of the SDK's `RequestHandlerExtra` the proxy handler needs:
 * the caller's `progressToken` (present only if the client requested
 * progress) and a `sendNotification` bound to this request's stream.
 * Typed minimally so the `registerTool` cast stays self-contained.
 */
export type ProxyToolExtra = {
  _meta?: { progressToken?: string | number }
  sendNotification?: (n: {
    method: 'notifications/progress'
    params: { progressToken: string | number; progress: number; message?: string }
  }) => Promise<void>
}

/**
 * Run a (potentially multi-minute) upstream call while keeping the stream
 * back to the agent alive. A silent call lets intermediaries drop the
 * connection — notably Anthropic's hosted MCP proxy (`-32000 "MCP server
 * connection lost"`) and Claude Code's 5-min idle timer — so we send a
 * `notifications/progress` ping every HEARTBEAT_MS for the duration.
 *
 * No-op unless the client supplied a `progressToken` (i.e. requested
 * progress): the spec ties progress notifications to that token, so
 * without one there is nothing valid to send. Best-effort — a failed
 * ping (e.g. the stream is already closing) is swallowed.
 */
export async function callWithHeartbeat<T>(
  extra: ProxyToolExtra | undefined,
  run: () => Promise<T>
): Promise<T> {
  const token = extra?._meta?.progressToken
  const send = extra?.sendNotification
  if (token == null || !send) return run()
  let progress = 0
  const timer = setInterval(() => {
    progress += 1
    void send({
      method: 'notifications/progress',
      params: { progressToken: token, progress, message: 'Upstream call in progress…' }
    }).catch(() => {})
  }, HEARTBEAT_MS)
  try {
    return await run()
  } finally {
    clearInterval(timer)
  }
}

/**
 * Structured notice substituted for an upstream response that exceeded
 * the relay size cap (WI-4). Generic scope hint — we don't know each
 * tool's pagination params, so we name the common levers. First-party
 * text (no upstream input), so no sanitisation needed.
 */
export function truncationNotice(slug: string, tool: string, bytes: number, cap: number): string {
  return firstParty(
    `The response from ${slug}.${tool} was ${bytes} bytes, over the ` +
      `${cap}-byte relay cap, and was withheld to protect the agent's context. ` +
      `Re-run with a narrower scope (e.g. a path, directory, depth, or page/limit ` +
      `argument) so the tool returns a smaller payload.`
  )
}
