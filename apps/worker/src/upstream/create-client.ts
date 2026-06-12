/**
 * Build the right UpstreamClient for a connection — the single dispatch
 * point over the transport implementations. Lives apart from the
 * `upstream-client.ts` interface module so the dependency graph stays
 * one-way: types ← implementation ← factory (no cycle).
 */

import type { UpstreamConnection } from '../db/queries/upstreams'
import type { UpstreamClient } from './upstream-client'
import { UpstreamHttpClient } from './http-client'

/**
 * Today every supported transport (`streamable_http`, `sse`) is dialed
 * over HTTP via `UpstreamHttpClient`; additional transports plug in here.
 */
export function createUpstreamClient(
  conn: UpstreamConnection,
  bearer: string | null
): UpstreamClient {
  return new UpstreamHttpClient(conn, bearer)
}
