import { Hono } from 'hono'
import type { Env } from '../env'
import type { HealthResponse } from '@ctxlayer/shared'
import { CRON_STALE_AFTER_S, LAST_CRON_KV_KEY } from '../ops/cron-heartbeat'
import { errMessage } from '../util/errors'

/**
 * PUBLIC, UNAUTHENTICATED SURFACE. On Access-fronted deploys a Bypass
 * app exposes this route to the open internet for external monitoring —
 * and Access path-matching includes SUBPATHS, so the bypass covers
 * /api/health/** wholesale. Two invariants follow:
 *
 *   1. NEVER mount another route under /api/health/ — it would ship
 *      Access-unprotected (app-level auth would be its only gate).
 *   2. The response body must stay safe for anonymous eyes: ok flags,
 *      version/buildAt, dependency names + latencies. Dependency
 *      FAILURE DETAIL is logged server-side only (see `timed`) — raw
 *      binding errors during an outage are internal diagnostics, not
 *      something to hand every visitor exactly when we're weakest.
 */
export const healthRoute = new Hono<{ Bindings: Env }>()

healthRoute.get('/', async (c) => {
  // Critical deps gate overall health (a failure ⇒ 503): the request path
  // can't serve without them. Soft deps are reported but don't 503 — search
  // degradation or a not-yet-fired cron isn't "down", and shouldn't page.
  const [critical, soft] = await Promise.all([
    Promise.all([
      timed('db', async () => {
        // Intentional inline `SELECT 1` liveness probe — the one sanctioned
        // exception to the "SQL lives in db/queries/*" rule, since it's a
        // health check, not a data query.
        const row = await c.env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>()
        if (row?.ok !== 1) throw new Error('unexpected response')
      }),
      timed('oauth_kv', async () => {
        await c.env.OAUTH_KV.get('__healthcheck')
      }),
      timed('docs_r2', async () => {
        // head() on a missing key returns null (not an error), so this probes
        // connectivity without needing a fixture object.
        await c.env.DOCS_BUCKET.head('__healthcheck')
      })
    ]),
    Promise.all([
      timed('vectorize', async () => {
        await c.env.DOCS_INDEX.describe()
      }),
      timed('cron', async () => {
        await checkCronFresh(c.env)
      })
    ])
  ])

  const ok = critical.every((d) => d.ok)
  const body: HealthResponse = {
    ok,
    version: c.env.GIT_SHA || '0.0.0',
    builtAt: c.env.BUILT_AT ?? '',
    dependencies: [...critical, ...soft]
  }
  return c.json(body, ok ? 200 : 503)
})

/**
 * Cron-liveness: the scheduled handler stamps `ops:last_cron` on every firing.
 * A missing stamp is tolerated for one staleness window after a fresh deploy
 * (the cron hasn't had a chance to run); after that, or once the stamp ages
 * past the window, the scheduler is considered stalled.
 */
async function checkCronFresh(env: Env): Promise<void> {
  const nowS = Math.floor(Date.now() / 1000)
  const raw = await env.OAUTH_KV.get(LAST_CRON_KV_KEY)
  if (!raw) {
    const builtS = env.BUILT_AT ? Math.floor(Date.parse(env.BUILT_AT) / 1000) : 0
    if (builtS && nowS - builtS < CRON_STALE_AFTER_S) return // fresh deploy grace
    throw new Error('no cron run recorded')
  }
  const age = nowS - Number(raw)
  if (age > CRON_STALE_AFTER_S) throw new Error(`stale: last cron ${age}s ago`)
}

async function timed(name: string, fn: () => Promise<void>) {
  const start = Date.now()
  try {
    await fn()
    return { name, ok: true, latencyMs: Date.now() - start }
  } catch (err) {
    // Detail stays server-side (header note #2): a monitor needs WHICH
    // dependency is down (name + ok:false), not the raw binding error.
    console.error(`[health] ${name} probe failed: ${errMessage(err)}`)
    return { name, ok: false, latencyMs: Date.now() - start }
  }
}
