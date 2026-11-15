/**
 * Freshness of the org-global upstream tool catalogue (`upstream_tools`).
 *
 * The catalogue is a D1 cache of each upstream's `tools/list`, shared by every
 * user and both lanes. A read serves the cache; a cache that is empty or older
 * than the TTL is refreshed inline, within a budget, by whoever notices.
 */

import type { Env } from '../env'
import type { UpstreamConnection } from '../db/queries/upstreams'
import {
  listCachedTools,
  replaceCachedTools,
  type UpstreamToolRow
} from '../db/queries/upstream-tools'
import type { UpstreamClient } from '../upstream/upstream-client'
import { errMessage } from '../util/errors'

// 24h cache TTL per docs/plan/C-upstream-proxy.md §C1.
export const CATALOGUE_TTL_SECONDS = 24 * 60 * 60

/**
 * How long a stale-catalogue refresh may hold up the caller before the
 * cached catalogue is served instead. On the session lane `init()` runs
 * inside the DO's `blockConcurrencyWhile`, which the runtime cancels at ~30 s
 * and answers by RESETTING the object — so one hung upstream used to take the
 * whole session down with it (2026-10-06: 22 resets in a day while the ADO
 * MCP was taking minutes per call). The per-call listTools timeout (60 s) is
 * far past that window, hence a separate, much tighter budget here. The
 * refresh is not abandoned: it keeps running and heals the cache for the
 * next reader.
 */
export const CATALOGUE_REFRESH_BUDGET_MS = 10_000

/** True when the cached rows are missing or older than the TTL. */
export function isCatalogueStale(cached: Pick<UpstreamToolRow, 'cached_at'>[]): boolean {
  // Staleness is derived from the prefetched rows (cached_at rides on
  // every row), so the fresh path costs no extra round trip.
  if (cached.length === 0) return true
  const cachedAt = Math.max(...cached.map((t) => t.cached_at))
  return Date.now() / 1000 - cachedAt > CATALOGUE_TTL_SECONDS
}

/**
 * The catalogue to serve for one upstream: `cached` when fresh, otherwise the
 * cache as it stands after giving a live refresh up to `budgetMs`.
 */
export async function ensureFreshCatalogue(
  env: Env,
  conn: UpstreamConnection,
  client: UpstreamClient,
  cached: UpstreamToolRow[],
  budgetMs: number = CATALOGUE_REFRESH_BUDGET_MS
): Promise<UpstreamToolRow[]> {
  if (!isCatalogueStale(cached)) return cached
  let timer: ReturnType<typeof setTimeout> | undefined
  const outOfBudget = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), budgetMs)
  })
  const outcome = await Promise.race([refreshCatalogue(env, conn, client), outOfBudget])
  clearTimeout(timer)
  if (outcome === 'timeout') {
    console.warn(
      `[catalogue] ${conn.slug}: tools/list still running after ${budgetMs}ms — ` +
        'serving the cached catalogue; the refresh continues in the background'
    )
  }
  // Whatever the refresh did (or has not done yet), serve the cache —
  // stale beats nothing, and beats a reset session.
  return listCachedTools(env, conn.id)
}

/** Fetch and store a fresh catalogue. Never throws: failures are logged. */
async function refreshCatalogue(
  env: Env,
  conn: UpstreamConnection,
  client: UpstreamClient
): Promise<'done'> {
  try {
    const tools = await client.listTools()
    const res = await replaceCachedTools(env, conn.id, tools)
    if (res.rejectedShrink) {
      console.warn(
        `[catalogue] ${conn.slug}: refresh returned ${res.rejectedShrink.incoming} tools vs ` +
          `${res.rejectedShrink.prior} cached — suspect shrink rejected, serving prior catalogue`
      )
    }
  } catch (err) {
    const msg = errMessage(err)
    console.error(`[catalogue] ${conn.slug}: tools/list failed: ${msg}`)
  }
  return 'done'
}
