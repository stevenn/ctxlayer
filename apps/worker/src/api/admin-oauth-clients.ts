/**
 * Admin REST for the OAuth-clients viewer (M5 phase 4).
 *
 * `GET /api/admin/oauth-clients?cursor=<c>&limit=<n>` returns a page
 * of clients registered via Dynamic Client Registration (or created
 * programmatically).
 *
 * `POST /api/admin/oauth-clients/prune` runs the orphan-client prune
 * on demand (same policy as the nightly cron) — the only mutating
 * route here, gated by `requireCsrf`. The SDK's DCR endpoint at
 * `/oauth/register` remains the only *creator* of clients.
 *
 * Constructs a read-only `OAuthHelpers` via `getOAuthApi()` against
 * the same options the live provider uses (`oauth/provider-config.ts`)
 * so the helpers point at the matching KV namespace + key layout.
 */

import { Hono } from 'hono'
import { getOAuthApi } from '@cloudflare/workers-oauth-provider'
import type {
  OAuthClientRow,
  OAuthClientsResponse,
  OAuthClientsPruneResponse
} from '@ctxlayer/shared'
import type { Env } from '../env'
import { requireAdmin, type AuthedVariables } from '../auth/middleware'
import { requireCsrf } from '../auth/csrf'
import { oauthProviderOptions } from '../oauth/provider-config'
import { buildUserGrantIndex } from '../oauth/client-grants'
import { pruneOrphanOAuthClients } from '../oauth/prune-clients'

export const adminOAuthClientsRoute = new Hono<{
  Bindings: Env
  Variables: AuthedVariables
}>()
adminOAuthClientsRoute.use('*', requireAdmin)

adminOAuthClientsRoute.get('/', async (c) => {
  const url = new URL(c.req.url)
  const cursor = url.searchParams.get('cursor') ?? undefined
  const limitRaw = url.searchParams.get('limit')
  let limit = limitRaw ? Number(limitRaw) : 100
  if (!Number.isFinite(limit) || limit < 1) limit = 100
  if (limit > 500) limit = 500

  const helpers = getOAuthApi<Env>(oauthProviderOptions(), c.env)
  // Kick off both reads in parallel — clients page + user-grant index.
  // The user-grant fan-out is bounded by the number of ctxlayer users
  // (<100 in the design target) so the parallel KV reads are cheap.
  const [page, grants] = await Promise.all([
    helpers.listClients({ limit, cursor }),
    buildUserGrantIndex(c.env, helpers)
  ])
  const userGrantIndex = grants.index

  const clients: OAuthClientRow[] = page.items.map((ci) => ({
    clientId: ci.clientId,
    clientName: ci.clientName ?? null,
    redirectUris: ci.redirectUris,
    registrationDate: ci.registrationDate ?? null,
    tokenEndpointAuthMethod: ci.tokenEndpointAuthMethod,
    grantTypes: ci.grantTypes ?? null,
    responseTypes: ci.responseTypes ?? null,
    clientUri: ci.clientUri ?? null,
    logoUri: ci.logoUri ?? null,
    policyUri: ci.policyUri ?? null,
    tosUri: ci.tosUri ?? null,
    contacts: ci.contacts ?? null,
    users: userGrantIndex.get(ci.clientId) ?? []
  }))

  const body: OAuthClientsResponse = {
    clients,
    nextCursor: page.cursor ?? null
  }
  return c.json(body)
})

/**
 * Admin-triggered orphan-client prune. Deletes public, zero-grant DCR
 * registrations older than 1 day — identical policy to the nightly
 * cron, just on demand so an admin can clear the loopback-OAuth
 * detritus without waiting. `requireCsrf` because this mutates KV.
 * Fail-closed: if the grant index is incomplete the helper deletes
 * nothing and reports `skippedIncompleteIndex` (the SPA surfaces it).
 */
adminOAuthClientsRoute.post('/prune', requireCsrf, async (c) => {
  const helpers = getOAuthApi<Env>(oauthProviderOptions(), c.env)
  const result = await pruneOrphanOAuthClients(c.env, helpers, {
    olderThanDays: 1
  })
  const body: OAuthClientsPruneResponse = result
  return c.json(body)
})
