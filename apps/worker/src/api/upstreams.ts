/**
 * User-facing REST for the per-user upstream connection flow.
 *
 * - `GET  /api/upstreams`               — list visible-to-caller upstreams.
 * - `PUT  /api/upstreams/:id/credentials` — paste a bearer token; sealed via aead.
 * - `DELETE /api/upstreams/:id/credentials` — revoke this user's creds.
 *
 * Admin CRUD on the upstream definitions themselves lives under
 * `/api/admin/upstreams/*`. OAuth credential flows ship in M5.
 */

import { Hono } from 'hono'
import { PasteBearerRequest } from '@ctxlayer/shared'
import type { Env } from '../env'
import { requireUser, type AuthedVariables } from '../auth/middleware'
import { requireCsrf } from '../auth/csrf'
import { seal } from '../crypto/aead'
import {
  getUpstreamById,
  listUpstreamsVisibleToUser,
  listUserUpstreamSummaries
} from '../db/queries/upstreams'
import {
  deleteUserCredential,
  upsertUserCredential
} from '../db/queries/upstream-credentials'
import { refreshCatalogueByUpstreamId } from '../upstream/catalogue'
import { buildUpstreamToolsPayload } from './upstreams-attachments'
import { notFound, parseJsonBody } from './respond'

export const upstreamsRoute = new Hono<{ Bindings: Env; Variables: AuthedVariables }>()
upstreamsRoute.use('*', requireUser)

upstreamsRoute.get('/', async (c) => {
  const userId = c.get('user').userId
  const summaries = await listUserUpstreamSummaries(c.env, userId)
  return c.json(summaries)
})

// Read-only view of the cached tool catalogue for one upstream. Used
// by the expand-row on /upstreams so a user can see which tools a
// connected upstream exposes. Gated on the same visibility rules that
// `GET /` uses — anything not visible to the caller returns 404 so we
// don't leak the existence of upstreams scoped to other teams.
upstreamsRoute.get('/:id/tools', async (c) => {
  const userId = c.get('user').userId
  const id = c.req.param('id')
  const visible = await listUpstreamsVisibleToUser(c.env, userId)
  const row = visible.find((r) => r.id === id)
  if (!row) return notFound(c)
  return c.json(await buildUpstreamToolsPayload(c.env, { id, slug: row.slug }))
})

upstreamsRoute.put('/:id/credentials', requireCsrf, async (c) => {
  const userId = c.get('user').userId
  const id = c.req.param('id')
  const upstream = await getUpstreamById(c.env, id)
  if (!upstream) return notFound(c)
  if (upstream.auth_strategy !== 'user_bearer') {
    // Pasting a bearer for shared_bearer / none / user_oauth upstreams
    // is meaningless or wrong — surface a 400 so the SPA can disable
    // the input on the wrong card type.
    return c.json({ error: 'auth_strategy_mismatch', expected: 'user_bearer' }, 400)
  }
  const parsed = await parseJsonBody(c, PasteBearerRequest)
  if (!parsed.ok) return parsed.res
  const sealed = await seal(parsed.data.token, c.env.ENCRYPTION_KEY)
  await upsertUserCredential(c.env, userId, id, {
    kind: 'bearer',
    ciphertext: sealed.ciphertext,
    iv: sealed.iv,
    keyVersion: sealed.keyVersion
  })
  // Warm the catalogue with the just-stored token so the admin UI's
  // tool count and the next MCP session see a populated cache without
  // waiting for the user to open an agent. Best-effort.
  const token = parsed.data.token
  c.executionCtx.waitUntil(
    refreshCatalogueByUpstreamId(c.env, id, token).then((r) => {
      if (!r.ok && r.reason === 'listTools_failed') {
        console.warn(`background catalogue refresh failed for ${id}:`, r.message)
      }
    })
  )
  return new Response(null, { status: 204 })
})

upstreamsRoute.delete('/:id/credentials', requireCsrf, async (c) => {
  const userId = c.get('user').userId
  const id = c.req.param('id')
  await deleteUserCredential(c.env, userId, id)
  return new Response(null, { status: 204 })
})
