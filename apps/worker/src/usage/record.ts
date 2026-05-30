import type { Env } from '../env'
import { byteLength, tokenCount } from './tokens'
import type { UsageEventMsg } from './event'

/**
 * Producer-side usage helper. Called from every MCP tool-call site
 * (built-ins in `mcp/session-do.ts`, upstream proxy in
 * `mcp/tools-proxy.ts`).
 *
 * Counts bytes + tokens of the request/response JSON, then enqueues a
 * `UsageEventMsg` for `usageConsumer` to write to D1. Wrapped in
 * `ctx.waitUntil(...)` so the tool response isn't blocked on either
 * the tokenisation pass or the queue write.
 *
 * Failures are swallowed — usage tracking must never break a working
 * tool call. Logged via `console.error` so they're visible in
 * `wrangler tail` if they start happening.
 */
export interface RecordUsageArgs {
  userId: string
  sessionId: string
  upstreamId: string | null
  tool: string
  reqJson: string
  respJson: string
  latencyMs: number
  status: 'ok' | 'error' | 'timeout'
  // True when the proxy replaced an oversized response with a truncation
  // notice (WI-4). Optional so built-in tool call sites need not pass it.
  truncated?: boolean
}

export function recordUsage(
  env: Env,
  ctx: { waitUntil: (p: Promise<unknown>) => void },
  args: RecordUsageArgs
): void {
  ctx.waitUntil(
    (async () => {
      try {
        const msg: UsageEventMsg = {
          id: crypto.randomUUID().replace(/-/g, ''),
          ts: Math.floor(Date.now() / 1000),
          userId: args.userId,
          sessionId: args.sessionId,
          upstreamId: args.upstreamId,
          tool: args.tool,
          reqBytes: byteLength(args.reqJson),
          respBytes: byteLength(args.respJson),
          reqTokens: tokenCount(args.reqJson),
          respTokens: tokenCount(args.respJson),
          latencyMs: args.latencyMs,
          status: args.status,
          truncated: args.truncated ?? false
        }
        await env.USAGE_QUEUE.send(msg)
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err)
        console.error(`[usage] enqueue failed for ${args.tool}: ${m}`)
      }
    })()
  )
}
