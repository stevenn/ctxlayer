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
import type {
  OAuthClientRow,
  OAuthClientUserRef,
  OAuthClientsResponse
} from '@ctxlayer/shared'
import type { Env } from '../env'
import { requireAdmin, type AuthedVariables } from '../auth/middleware'
import { oauthProviderOptions } from '../oauth/provider-config'
import { listUserRefs } from '../db/queries/users'

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
  const [page, userGrantIndex] = await Promise.all([
    helpers.listClients({ limit, cursor }),
    buildUserGrantIndex(c.env, helpers)
  ])

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
 * Build a clientId → user-grant[] map. Walks every ctxlayer user in
 * parallel via OAuthHelpers.listUserGrants (the SDK has no inverse
 * "grants for client" lookup), then groups + dedupes server-side.
 *
 * On any per-user failure we swallow and continue — the worst case
 * is that one row's `users` column under-counts, which is far less
 * disruptive than failing the whole admin page.
 *
 * Each (client, user) pair appears at most once; we keep the earliest
 * `createdAt` as `grantedAt` — that's the original authorisation
 * moment, which is what the admin actually cares about (refresh
 * exchanges create new grant rows over time).
 */
async function buildUserGrantIndex(
  env: Env,
  helpers: ReturnType<typeof getOAuthApi<Env>>
): Promise<Map<string, OAuthClientUserRef[]>> {
  const users = await listUserRefs(env)
  if (users.length === 0) return new Map()
  const perUser = await Promise.all(
    users.map(async (u) => {
      try {
        // listUserGrants is paginated; we pull the first page only
        // since our scale is bounded. Promote to full pagination if
        // a single user ever accumulates >100 grants (unlikely).
        const page = await helpers.listUserGrants(u.id, { limit: 200 })
        return { user: u, grants: page.items }
      } catch (err) {
        console.warn(
          `[admin-oauth-clients] listUserGrants(${u.id}) failed:`,
          err instanceof Error ? err.message : String(err)
        )
        return { user: u, grants: [] }
      }
    })
  )

  const index = new Map<string, OAuthClientUserRef[]>()
  for (const { user, grants } of perUser) {
    for (const g of grants) {
      const list = index.get(g.clientId) ?? []
      const existing = list.find((ref) => ref.userId === user.id)
      if (existing) {
        if (g.createdAt < existing.grantedAt) existing.grantedAt = g.createdAt
      } else {
        list.push({
          userId: user.id,
          email: user.email,
          name: user.name,
          grantedAt: g.createdAt
        })
      }
      index.set(g.clientId, list)
    }
  }
  // Stable ordering per client — earliest grant first.
  for (const list of index.values()) list.sort((a, b) => a.grantedAt - b.grantedAt)
  return index
}
