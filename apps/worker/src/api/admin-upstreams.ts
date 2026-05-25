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
  replaceVisibility,
  toUpstreamConnection
} from '../db/queries/upstreams'
import {
  refreshCatalogueByUpstreamId,
  refreshCatalogueForConnection
} from '../upstream/catalogue'
import { resolveUserUpstreamBearer } from '../upstream/bearer'

export const adminUpstreamsRoute = new Hono<{ Bindings: Env; Variables: AuthedVariables }>()
adminUpstreamsRoute.use('*', requireAdmin)
adminUpstreamsRoute.use('*', requireCsrf)

adminUpstreamsRoute.get('/', async (c) => {
  const userId = c.get('user').userId
  const rows = await listUpstreams(c.env)
  const hydrated = await Promise.all(rows.map((r) => adminRowFor(c.env, r.id, userId)))
  return c.json(hydrated.filter((x) => x !== null))
})

adminUpstreamsRoute.get('/:id', async (c) => {
  const userId = c.get('user').userId
  const row = await adminRowFor(c.env, c.req.param('id'), userId)
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
    // For unauth (`none`) upstreams there's nothing to wait for —
    // warm the catalogue immediately so the admin sees a real tool
    // count in the drawer instead of zero. user_bearer / user_oauth /
    // shared_bearer all need credentials before refresh is meaningful;
    // those are warmed on connect (PUT credentials / OAuth callback).
    if (input.authStrategy === 'none') {
      c.executionCtx.waitUntil(
        refreshCatalogueByUpstreamId(c.env, row.id, null).then(
          (r) => {
            if (r.ok) {
              console.log(
                `[catalogue] ${r.slug}: warmed ${r.toolsCount} tools on create (auth=none)`
              )
            } else {
              console.warn(
                `[catalogue] ${row.slug}: post-create refresh failed (${r.reason})${
                  r.message ? `: ${r.message}` : ''
                }`
              )
            }
          },
          (err) => {
            const msg = err instanceof Error ? err.message : String(err)
            console.error(`[catalogue] ${row.slug}: post-create refresh threw: ${msg}`)
          }
        )
      )
    }
    const hydrated = await adminRowFor(c.env, row.id, c.get('user').userId)
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
 * Admin-triggered catalogue refresh. Uses the calling admin's own
 * credentials for upstreams that need them (paste-bearer for
 * `user_bearer`, OAuth tokens for `user_oauth`, no creds for `none`).
 * If the admin hasn't connected the upstream on `/upstreams` yet, we
 * tell them so they can connect once and reuse the refresh button
 * thereafter. The per-user MCP session refresh path is still available
 * as a fallback for non-admin users on session init.
 */
adminUpstreamsRoute.post('/:id/refresh-tools', async (c) => {
  const id = c.req.param('id')
  const row = await getUpstreamById(c.env, id)
  if (!row) return c.json({ error: 'not_found' }, 404)
  let conn
  try {
    conn = toUpstreamConnection(row)
  } catch {
    return c.json({ error: 'unsupported_transport' }, 400)
  }
  const userId = c.get('user').userId
  const bearer = await resolveUserUpstreamBearer(c.env, row, conn, userId)
  if (conn.authStrategy !== 'none' && bearer === null) {
    return c.json(
      {
        error: 'admin_not_connected',
        hint: `Connect this upstream on /upstreams as ${conn.authStrategy}, then try again.`
      },
      400
    )
  }
  const result = await refreshCatalogueForConnection(c.env, conn, bearer)
  if (!result.ok) {
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
