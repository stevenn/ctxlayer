/**
 * Catalogue-refresh helper. Used by:
 *   - the admin "Refresh tools" endpoint (for `none` / `shared_bearer`
 *     upstreams that don't need a per-user token);
 *   - the user `PUT /api/upstreams/:id/credentials` flow, which fires
 *     a refresh in `ctx.waitUntil` so the cached `upstream_tools`
 *     populates without waiting for the next MCP session;
 *   - the per-session `UpstreamProxyRegistry` when a cache is empty
 *     or older than the TTL.
 *
 * Best-effort: failures are logged and surfaced via the return value
 * so callers can decide whether to bubble them up (admin) or swallow
 * them (user paste, waitUntil background).
 */

import type { Env } from '../env'
import {
  getUpstreamById,
  replaceCachedTools,
  toUpstreamConnection,
  type UpstreamConnection
} from '../db/queries/upstreams'
import { createUpstreamClient } from './upstream-client'

export interface CatalogueRefreshOk {
  ok: true
  slug: string
  toolsCount: number
  cachedAt: number
}

export interface CatalogueRefreshErr {
  ok: false
  reason:
    | 'not_found'
    | 'unsupported_transport'
    | 'no_credentials'
    | 'listTools_failed'
  message?: string
}

export type CatalogueRefreshResult = CatalogueRefreshOk | CatalogueRefreshErr

export async function refreshCatalogueByUpstreamId(
  env: Env,
  upstreamId: string,
  bearerToken: string | null
): Promise<CatalogueRefreshResult> {
  const row = await getUpstreamById(env, upstreamId)
  if (!row) return { ok: false, reason: 'not_found' }
  let conn: UpstreamConnection
  try {
    conn = toUpstreamConnection(row)
  } catch {
    return { ok: false, reason: 'unsupported_transport' }
  }
  return refreshCatalogueForConnection(env, conn, bearerToken)
}

export async function refreshCatalogueForConnection(
  env: Env,
  conn: UpstreamConnection,
  bearerToken: string | null
): Promise<CatalogueRefreshResult> {
  if (conn.authStrategy !== 'none' && !bearerToken) {
    return { ok: false, reason: 'no_credentials' }
  }
  const client = createUpstreamClient(conn, bearerToken)
  try {
    const tools = await client.listTools()
    const cachedAt = await replaceCachedTools(env, conn.id, tools)
    return { ok: true, slug: conn.slug, toolsCount: tools.length, cachedAt }
  } catch (err) {
    return {
      ok: false,
      reason: 'listTools_failed',
      message: err instanceof Error ? err.message : String(err)
    }
  } finally {
    await client.close()
  }
}
