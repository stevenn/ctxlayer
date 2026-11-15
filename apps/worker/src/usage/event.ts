import { z } from 'zod'
import { USAGE_LANES, type UsageLane } from '@ctxlayer/shared'

/**
 * Queue message contract between producer (`usage/record.ts`) and
 * consumer (`queues/usage-consumer.ts`). Counts (bytes + tokens) are
 * pre-computed on the producer side so the consumer is pure SQL —
 * keeps queue messages bounded (Cloudflare's 128KB cap), avoids
 * shipping potentially-large tool payloads through the queue, and
 * reuses the worker's already-loaded tiktoken encoder.
 *
 * The `null` upstream id (= built-in tool like `whoami` / `search_docs`)
 * is normalised to `''` by the consumer on insert into
 * `usage_rollups_daily` so the PK column stays NOT NULL.
 */
export const UsageEventMsg = z.object({
  id: z.string(),
  ts: z.number().int(),
  userId: z.string(),
  sessionId: z.string(),
  upstreamId: z.string().nullable(),
  tool: z.string(),
  reqBytes: z.number().int().min(0),
  respBytes: z.number().int().min(0),
  reqTokens: z.number().int().min(0),
  respTokens: z.number().int().min(0),
  latencyMs: z.number().int().min(0),
  status: z.enum(['ok', 'error', 'timeout']),
  // WI-5: set when the proxy replaced an oversized response with a
  // truncation notice. Optional with a default so messages enqueued
  // before this field existed still parse on the consumer.
  truncated: z.boolean().default(false),
  // Per-error forensics (status <> 'ok' only): a coarse class + a
  // credential-scrubbed detail message, written to the raw event row and
  // surfaced in the usage error table. Nullish so events enqueued before
  // these fields existed still parse on the consumer.
  errorCode: z.string().nullish(),
  errorMessage: z.string().nullish(),
  // Which MCP lane served the call, the protocol revision it negotiated and
  // the client's self-reported name (see `UsageOrigin`). Nullish so events
  // enqueued before lane tracking still parse on the consumer.
  lane: z.enum(USAGE_LANES).nullish(),
  protocolVersion: z.string().nullish(),
  clientName: z.string().nullish()
})
export type UsageEventMsg = z.infer<typeof UsageEventMsg>

/**
 * Where a tool call came in: the lane that served it, plus what the client
 * said about itself. Each lane knows this differently — the session lane from
 * the `initialize` handshake it stored, the stateless lane from the
 * per-request envelope — so both hand the usage pipeline this one shape.
 */
export interface UsageOrigin {
  lane: UsageLane
  protocolVersion?: string | null
  clientName?: string | null
}

/** Cap for the client-supplied name: it is free text from the wire. */
export const CLIENT_NAME_MAX = 80

/** Trim, collapse and cap a client-supplied name; empty becomes null. */
export function cleanClientName(name: unknown): string | null {
  if (typeof name !== 'string') return null
  const clean = name.replace(/\s+/g, ' ').trim().slice(0, CLIENT_NAME_MAX)
  return clean || null
}
