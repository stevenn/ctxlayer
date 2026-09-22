/**
 * The MCP-login activity ledger (migration 0038): one row per live OAuth
 * grant, stamped on every token exchange.
 *
 * This is what makes a login *sliding* — the library only knows the absolute
 * instant a grant was authorized, so "has this login been used lately?" has
 * no answer in KV. `stampGrantActivity` runs on the token endpoint's hot
 * path (once per refresh, i.e. roughly hourly per connected client process),
 * so it is one indexed UPSERT and nothing more.
 *
 * Bounded by the number of LIVE grants (hundreds at org scale), because the
 * nightly sweep deletes rows whose grant is gone — see oauth/grant-sweep.ts.
 */

import type { Env } from '../../env'

export interface GrantActivityRow {
  grantId: string
  userId: string
  clientId: string
  createdAt: number
  lastRefreshAt: number
}

/**
 * Backstop on the sweep's full-table read. Far above the live-grant count
 * of any single-org install; a table bigger than this means the sweep's
 * orphan deletion has stopped running, which the job ledger will show.
 */
export const GRANT_ACTIVITY_SCAN_LIMIT = 5000

interface Row {
  grant_id: string
  user_id: string
  client_id: string
  created_at: number
  last_refresh_at: number
}

const toRow = (r: Row): GrantActivityRow => ({
  grantId: r.grant_id,
  userId: r.user_id,
  clientId: r.client_id,
  createdAt: r.created_at,
  lastRefreshAt: r.last_refresh_at
})

/**
 * Record that a grant was just exchanged. INSERT on the first exchange
 * (the code exchange that created it), UPDATE of `last_refresh_at` on every
 * refresh after that — `created_at` is never moved, so the row also carries
 * the original authorization moment.
 */
export async function stampGrantActivity(
  env: Env,
  input: { grantId: string; userId: string; clientId: string; now: number }
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO oauth_grant_activity (grant_id, user_id, client_id, created_at, last_refresh_at)
     VALUES (?1, ?2, ?3, ?4, ?4)
     ON CONFLICT(grant_id) DO UPDATE SET last_refresh_at = excluded.last_refresh_at`
  )
    .bind(input.grantId, input.userId, input.clientId, input.now)
    .run()
}

/** Every ledger row, oldest-quiet first (the sweep reads the whole table). */
export async function listGrantActivity(env: Env): Promise<GrantActivityRow[]> {
  const res = await env.DB.prepare(
    `SELECT grant_id, user_id, client_id, created_at, last_refresh_at
       FROM oauth_grant_activity
      ORDER BY last_refresh_at ASC
      LIMIT ?1`
  )
    .bind(GRANT_ACTIVITY_SCAN_LIMIT)
    .all<Row>()
  return (res.results ?? []).map(toRow)
}

/**
 * Insert rows for grants the ledger has never seen, stamped NOW rather than
 * at their real last use — which we cannot know. That grace is deliberate:
 * grants that predate this table (and any grant whose stamps were lost to a
 * D1 outage) get a full idle window to prove they are alive instead of being
 * revoked on the first sweep. Existing rows are left untouched.
 */
export async function seedGrantActivity(
  env: Env,
  rows: Array<{ grantId: string; userId: string; clientId: string; createdAt: number }>,
  now: number
): Promise<number> {
  if (rows.length === 0) return 0
  const stmt = env.DB.prepare(
    `INSERT INTO oauth_grant_activity (grant_id, user_id, client_id, created_at, last_refresh_at)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(grant_id) DO NOTHING`
  )
  await env.DB.batch(
    rows.map((r) => stmt.bind(r.grantId, r.userId, r.clientId, r.createdAt, now))
  )
  return rows.length
}

/** Drop ledger rows (grant revoked, or gone from KV). */
export async function deleteGrantActivity(env: Env, grantIds: string[]): Promise<number> {
  if (grantIds.length === 0) return 0
  const stmt = env.DB.prepare(`DELETE FROM oauth_grant_activity WHERE grant_id = ?1`)
  await env.DB.batch(grantIds.map((id) => stmt.bind(id)))
  return grantIds.length
}

/** Drop every row for one user — suspend/delete revokes all their grants. */
export async function deleteGrantActivityForUser(env: Env, userId: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM oauth_grant_activity WHERE user_id = ?1`).bind(userId).run()
}
