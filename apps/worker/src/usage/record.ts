import { byteLength, tokenCount } from './tokens'
import { cleanClientName, type UsageEventMsg, type UsageOrigin } from './event'
import { newId } from '../db/queries/util'

/**
 * Producer-side usage helper. Called from every MCP tool-call site: the
 * built-in tools (via each lane's recorder), the upstream proxy, and the
 * async-jobs consumer.
 *
 * `buildUsageMsg` counts bytes + tokens of the request/response JSON and
 * assembles the `UsageEventMsg` the consumer writes to D1. Delivery to
 * `USAGE_QUEUE` is the caller's: the session lane stages the message in its
 * DO's SQLite outbox (`usage/outbox.ts`, drained on an alarm — see
 * `McpSessionDO`); callers with no outbox send it directly. The counts are
 * pre-computed here so the queue message stays small and the consumer is
 * pure SQL.
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
  // Lane + client identity of the call (see `UsageOrigin`). Optional so a
  // call site that cannot know it still records the call; such rows show up
  // under the "unknown" lane.
  origin?: UsageOrigin
}

export function buildUsageMsg(args: RecordUsageArgs): UsageEventMsg {
  return {
    id: newId(),
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
    errorMessage: args.errorMessage ?? null,
    lane: args.origin?.lane ?? null,
    protocolVersion: args.origin?.protocolVersion ?? null,
    clientName: cleanClientName(args.origin?.clientName)
  }
}
