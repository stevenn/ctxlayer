/**
 * Generic, pluggable upstream-client abstraction. Each transport family is
 * one implementation behind this interface; `createUpstreamClient` is the
 * single dispatch point, so a future transport slots in here without
 * re-plumbing the proxy/dispatch layer in `mcp/tools-proxy.ts`.
 *
 * The catalogue/result shapes live here (canonical home) and are re-exported
 * from `http-client.ts` for existing importers.
 */

import type { UpstreamConnection } from '../db/queries/upstreams'
import { UpstreamHttpClient } from './http-client'

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
 * Build the right UpstreamClient for a connection. Today every supported
 * transport (`streamable_http`, `sse`) is dialed over HTTP via
 * `UpstreamHttpClient`; additional transports plug in here.
 */
export function createUpstreamClient(
  conn: UpstreamConnection,
  bearer: string | null
): UpstreamClient {
  return new UpstreamHttpClient(conn, bearer)
}
