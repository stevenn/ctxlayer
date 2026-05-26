/**
 * Admin REST for the OAuth-clients viewer (M5 phase 4).
 *
 * `GET /api/admin/oauth-clients?cursor=<c>&limit=<n>` returns a page
 * of clients registered via Dynamic Client Registration (or created
 * programmatically). Read-only — no create/update/delete here yet;
 * the SDK's DCR endpoint at `/oauth/register` is the only writer.
 *
 * Constructs a read-only `OAuthHelpers` via `getOAuthApi()` against
 * the same options the live provider uses (`oauth/provider-config.ts`)
 * so the helpers point at the matching KV namespace + key layout.
 */

import { Hono } from 'hono'
import { getOAuthApi } from '@cloudflare/workers-oauth-provider'
import type { OAuthClientRow, OAuthClientsResponse } from '@ctxlayer/shared'
import type { Env } from '../env'
import { requireAdmin, type AuthedVariables } from '../auth/middleware'
import { oauthProviderOptions } from '../oauth/provider-config'

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
  const page = await helpers.listClients({ limit, cursor })

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
    contacts: ci.contacts ?? null
  }))

  const body: OAuthClientsResponse = {
    clients,
    nextCursor: page.cursor ?? null
  }
  return c.json(body)
})
