/**
 * Admin REST for `upstream_servers`, `upstream_visibility`, and the
 * cached `upstream_tools` catalogue.
 *
 * Stdio-via-Daytona transports are intentionally rejected at this
 * layer — `SupportedTransport` already narrows the request enum, and
 * we double-check before writing to D1 so a forged payload can't
 * sneak `stdio_daytona` into the CHECK constraint.
 */

import { Hono } from 'hono'
import {
  CreateUpstreamRequest,
  ReplaceVisibilityRequest,
  UpdateUpstreamRequest
} from '@ctxlayer/shared'
import type { Env } from '../env'
import { requireAdmin, type AuthedVariables } from '../auth/middleware'
import { requireCsrf } from '../auth/csrf'
import {
  adminRowFor,
  createUpstream,
  deleteUpstream,
  getUpstreamById,
  listUpstreams,
  patchUpstream,
  replaceVisibility
} from '../db/queries/upstreams'
import { refreshCatalogueByUpstreamId } from '../upstream/catalogue'

export const adminUpstreamsRoute = new Hono<{ Bindings: Env; Variables: AuthedVariables }>()
adminUpstreamsRoute.use('*', requireAdmin)
adminUpstreamsRoute.use('*', requireCsrf)

adminUpstreamsRoute.get('/', async (c) => {
  const rows = await listUpstreams(c.env)
  const hydrated = await Promise.all(rows.map((r) => adminRowFor(c.env, r.id)))
  return c.json(hydrated.filter((x) => x !== null))
})

adminUpstreamsRoute.get('/:id', async (c) => {
  const row = await adminRowFor(c.env, c.req.param('id'))
  if (!row) return c.json({ error: 'not_found' }, 404)
  return c.json(row)
})

adminUpstreamsRoute.post('/', async (c) => {
  const parsed = CreateUpstreamRequest.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    return c.json({ error: 'bad_request', issues: parsed.error.issues }, 400)
  }
  const input = parsed.data
  try {
    const row = await createUpstream(c.env, {
      slug: input.slug,
      displayName: input.displayName,
      transport: input.transport,
      url: input.url,
      authStrategy: input.authStrategy,
      authConfig: input.authConfig ?? {},
      enabled: input.enabled ?? true
    })
    const hydrated = await adminRowFor(c.env, row.id)
    return c.json(hydrated, 201)
  } catch (err) {
    if (isUniqueViolation(err)) return c.json({ error: 'slug_taken' }, 409)
    throw err
  }
})

adminUpstreamsRoute.patch('/:id', async (c) => {
  const id = c.req.param('id')
  if (!(await getUpstreamById(c.env, id))) return c.json({ error: 'not_found' }, 404)
  const parsed = UpdateUpstreamRequest.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    return c.json({ error: 'bad_request', issues: parsed.error.issues }, 400)
  }
  await patchUpstream(c.env, id, parsed.data)
  return new Response(null, { status: 204 })
})

adminUpstreamsRoute.delete('/:id', async (c) => {
  await deleteUpstream(c.env, c.req.param('id'))
  return new Response(null, { status: 204 })
})

// Replace the visibility rule-set for one upstream in a single batch.
adminUpstreamsRoute.put('/:id/visibility', async (c) => {
  const id = c.req.param('id')
  if (!(await getUpstreamById(c.env, id))) return c.json({ error: 'not_found' }, 404)
  const parsed = ReplaceVisibilityRequest.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    return c.json({ error: 'bad_request', issues: parsed.error.issues }, 400)
  }
  await replaceVisibility(c.env, id, parsed.data.rules)
  return new Response(null, { status: 204 })
})

/**
 * Admin-triggered catalogue refresh. Works for `none`-strategy upstreams
 * (no creds needed) — for `user_bearer` / `user_oauth` the catalogue
 * populates the first time a user pastes a token (see
 * `api/upstreams.ts` PUT credentials, which fires a refresh in
 * `ctx.waitUntil`).
 */
adminUpstreamsRoute.post('/:id/refresh-tools', async (c) => {
  const id = c.req.param('id')
  const result = await refreshCatalogueByUpstreamId(c.env, id, null)
  if (!result.ok) {
    if (result.reason === 'not_found') return c.json({ error: 'not_found' }, 404)
    if (result.reason === 'unsupported_transport') {
      return c.json({ error: 'unsupported_transport' }, 400)
    }
    if (result.reason === 'no_credentials') {
      return c.json({ error: 'user_credentials_required' }, 400)
    }
    return c.json({ error: 'refresh_failed', message: result.message }, 502)
  }
  return c.json({
    upstreamId: id,
    slug: result.slug,
    toolsCount: result.toolsCount,
    cachedAt: result.cachedAt
  })
})

function isUniqueViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /UNIQUE constraint failed/i.test(msg)
}
