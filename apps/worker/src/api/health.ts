import { Hono } from 'hono'
import type { Env } from '../env'
import type { HealthResponse } from '@ctxlayer/shared'

export const healthRoute = new Hono<{ Bindings: Env }>()

healthRoute.get('/', async (c) => {
  const checks = await Promise.all([
    timed('db', async () => {
      // Intentional inline `SELECT 1` liveness probe — the one sanctioned
      // exception to the "SQL lives in db/queries/*" rule, since it's a
      // health check, not a data query.
      const row = await c.env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>()
      if (row?.ok !== 1) throw new Error('unexpected response')
    }),
    timed('oauth_kv', async () => {
      await c.env.OAUTH_KV.get('__healthcheck')
    })
  ])

  const body: HealthResponse = {
    ok: checks.every((c) => c.ok),
    version: c.env.GIT_SHA || '0.0.0',
    builtAt: c.env.BUILT_AT ?? '',
    dependencies: checks
  }
  return c.json(body, body.ok ? 200 : 503)
})

async function timed(name: string, fn: () => Promise<void>) {
  const start = Date.now()
  try {
    await fn()
    return { name, ok: true, latencyMs: Date.now() - start }
  } catch (err) {
    return {
      name,
      ok: false,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}
