/**
 * clientId → user-grant[] index, shared by the OAuth-clients admin
 * viewer (`api/admin-oauth-clients.ts`) and the orphan-client prune
 * (`oauth/prune-clients.ts`).
 *
 * The SDK has no inverse "grants for client" lookup, so we fan
 * `OAuthHelpers.listUserGrants` over every ctxlayer user in parallel
 * and group by `clientId`. A client absent from the returned map has
 * zero grants — which is exactly the signal both callers need (the
 * viewer renders "none"; the prune treats it as an abandoned
 * registration).
 *
 * Per-user failures are swallowed so one bad read can't fail the admin
 * page — but we surface a `complete` flag alongside the index. That
 * matters for the prune: a swallowed failure makes a user's real grants
 * LOOK like zero, which would make a legitimate client look orphaned.
 * The prune therefore refuses to delete anything when `complete` is
 * false (fail-closed); the viewer ignores the flag and shows the
 * best-effort index.
 *
 * Each (client, user) pair appears once; we keep the earliest
 * `createdAt` as `grantedAt` — the original authorisation moment, which
 * is what the admin cares about (refresh exchanges create new grant
 * rows over time).
 */

import type { getOAuthApi } from '@cloudflare/workers-oauth-provider'
import type { OAuthClientUserRef } from '@ctxlayer/shared'
import type { Env } from '../env'
import { listUserRefs } from '../db/queries/users'
import { errMessage } from '../util/errors'

export type OAuthHelpers = ReturnType<typeof getOAuthApi<Env>>

export interface UserGrantIndex {
  /** clientId → users who hold a grant on it. Absent key = zero grants. */
  index: Map<string, OAuthClientUserRef[]>
  /** False if any per-user listUserGrants read failed (index undercounts). */
  complete: boolean
}

/** One live grant, flattened with the user who holds it. */
export interface GrantRef {
  id: string
  userId: string
  clientId: string
  createdAt: number
  user: { id: string; email: string; name: string | null }
}

export interface AllGrants {
  grants: GrantRef[]
  /** False if any per-user listUserGrants read failed (the list undercounts). */
  complete: boolean
}

/**
 * Every grant ctxlayer holds, by fanning `listUserGrants` over every user.
 * The SDK has no "list all grants", so this is the only enumeration there
 * is — shared by the client index below and the nightly idle sweep
 * (grant-sweep.ts), both of which must treat an incomplete read as "do not
 * act", hence the flag rather than a throw.
 */
export async function listAllGrants(env: Env, helpers: OAuthHelpers): Promise<AllGrants> {
  const users = await listUserRefs(env)
  if (users.length === 0) return { grants: [], complete: true }
  const perUser = await Promise.all(
    users.map(async (u) => {
      try {
        // listUserGrants is paginated; we pull the first page only
        // since our scale is bounded. Promote to full pagination if
        // a single user ever accumulates >200 grants (unlikely).
        const page = await helpers.listUserGrants(u.id, { limit: 200 })
        return { user: u, grants: page.items, ok: true }
      } catch (err) {
        console.warn(
          `[client-grants] listUserGrants(${u.id}) failed:`,
          errMessage(err)
        )
        return { user: u, grants: [], ok: false }
      }
    })
  )
  const grants: GrantRef[] = []
  for (const { user, grants: items } of perUser) {
    for (const g of items) {
      grants.push({
        id: g.id,
        userId: user.id,
        clientId: g.clientId,
        createdAt: g.createdAt,
        user
      })
    }
  }
  return { grants, complete: perUser.every((r) => r.ok) }
}

export async function buildUserGrantIndex(
  env: Env,
  helpers: OAuthHelpers
): Promise<UserGrantIndex> {
  const { grants, complete } = await listAllGrants(env, helpers)
  const index = new Map<string, OAuthClientUserRef[]>()
  for (const g of grants) {
    const list = index.get(g.clientId) ?? []
    const existing = list.find((ref) => ref.userId === g.userId)
    if (existing) {
      if (g.createdAt < existing.grantedAt) existing.grantedAt = g.createdAt
    } else {
      list.push({
        userId: g.userId,
        email: g.user.email,
        name: g.user.name,
        grantedAt: g.createdAt
      })
    }
    index.set(g.clientId, list)
  }
  // Stable ordering per client — earliest grant first.
  for (const list of index.values()) list.sort((a, b) => a.grantedAt - b.grantedAt)
  return { index, complete }
}
