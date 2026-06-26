import { byteLength, tokenCount } from './tokens'
import type { UsageEventMsg } from './event'

/**
 * Producer-side usage helper. Called from every MCP tool-call site
 * (built-ins in `mcp/session-do.ts`, upstream proxy in
 * `mcp/tools-proxy.ts`).
 *
 * `buildUsageMsg` counts bytes + tokens of the request/response JSON and
 * assembles the `UsageEventMsg` the consumer writes to D1. The caller
 * stages the result in the DO's SQLite outbox (`usage/outbox.ts`), which
 * is drained to `USAGE_QUEUE` on an alarm — see `McpSessionDO`. The
 * counts are pre-computed here so the queue message stays small and the
 * consumer is pure SQL.
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
  // Set on failures (status !== 'ok'): coarse class + credential-scrubbed
  // detail for the usage error drill-down. Omitted on the ok path. See
  // `usage/error-detail.ts`.
  errorCode?: string
  errorMessage?: string
}

export function buildUsageMsg(args: RecordUsageArgs): UsageEventMsg {
  return {
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
    truncated: args.truncated ?? false,
    errorCode: args.errorCode ?? null,
    errorMessage: args.errorMessage ?? null
  }
}
