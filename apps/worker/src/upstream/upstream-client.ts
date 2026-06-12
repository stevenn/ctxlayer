/**
 * Generic, pluggable upstream-client abstraction. Each transport family is
 * one implementation behind this interface; `createUpstreamClient` (in
 * `create-client.ts`) is the single dispatch point, so a future transport
 * slots in without re-plumbing the proxy/dispatch layer in
 * `mcp/tools-proxy.ts`.
 *
 * This module is the canonical home for the catalogue/result shapes and
 * the dialable-transport predicate. It imports nothing from the rest of
 * the worker — implementations depend on it, never the other way around.
 */

import type { SupportedTransport } from '@ctxlayer/shared'

export interface UpstreamCatalogueTool {
  toolName: string
  description: string | null
  inputSchema: unknown
}

export interface UpstreamCallResult {
  content: unknown
  isError?: boolean
  structuredContent?: unknown
}

export interface UpstreamClient {
  listTools(): Promise<UpstreamCatalogueTool[]>
  callTool(name: string, args: unknown): Promise<UpstreamCallResult>
  close(): Promise<void>
}

/**
 * The transports the worker can actually dial over HTTP. Any other
 * transport value (a legacy or forged DB row) must never surface as a
 * dialable connection. Single source of truth — SQL IN lists and
 * row-filtering checks are both built from this tuple.
 */
export const DIALABLE_TRANSPORTS = ['streamable_http', 'sse'] as const

export function isDialableTransport(t: string): t is SupportedTransport {
  return (DIALABLE_TRANSPORTS as readonly string[]).includes(t)
}
