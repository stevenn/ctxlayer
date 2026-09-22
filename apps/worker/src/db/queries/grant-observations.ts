/**
 * The measured half of "when does this authorization die" (migration 0039):
 * one row per upstream authorization that actually died here, reduced to a
 * per-upstream median the read paths can use without an aggregate.
 *
 * Recorded at the single moment both facts are known — the permanent-refresh
 * -failure flag, where `granted_at` is still the stamp of the grant that just
 * died. A later re-authorization restamps `granted_at`, so an observation not
 * taken here is not recoverable afterwards.
 */

import type { Env } from '../../env'
import { observedGrantDays } from '@ctxlayer/shared'

/** How many recent deaths the estimate is taken over. */
export const GRANT_OBSERVATION_WINDOW = 20

/**
 * Record one death and refold this upstream's estimate.
 *
 * Best-effort by contract: the caller is flagging a dead credential, and that
 * must not fail because a statistic could not be updated. Returns the new
 * estimate (or null while there are too few deaths to mean anything).
 */
export async function recordGrantDeath(
  env: Env,
  input: { upstreamId: string; userId: string; grantedAt: number; diedAt: number }
): Promise<number | null> {
  const lifetimeDays = (input.diedAt - input.grantedAt) / 86400
  // A non-positive lifetime is a clock artifact, not an observation.
  if (!(lifetimeDays > 0)) return null
  await env.DB.prepare(
    `INSERT INTO upstream_grant_observations
       (id, upstream_id, user_id, granted_at, died_at, lifetime_days)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
  )
    .bind(
      crypto.randomUUID(),
      input.upstreamId,
      input.userId,
      input.grantedAt,
      input.diedAt,
      lifetimeDays
    )
    .run()
  return refoldObservedGrantDays(env, input.upstreamId)
}

/** The recent measured lifetimes for one upstream, newest death first. */
export async function listGrantLifetimes(env: Env, upstreamId: string): Promise<number[]> {
  const res = await env.DB.prepare(
    `SELECT lifetime_days FROM upstream_grant_observations
      WHERE upstream_id = ?1 ORDER BY died_at DESC LIMIT ?2`
  )
    .bind(upstreamId, GRANT_OBSERVATION_WINDOW)
    .all<{ lifetime_days: number }>()
  return (res.results ?? []).map((r) => r.lifetime_days)
}

/**
 * Recompute one upstream's estimate from its recent deaths and denormalise it
 * onto the row. Called after each new observation — deaths are rare (tens per
 * month across an org), so there is no batching to win.
 */
export async function refoldObservedGrantDays(
  env: Env,
  upstreamId: string
): Promise<number | null> {
  const days = observedGrantDays(await listGrantLifetimes(env, upstreamId))
  await env.DB.prepare(`UPDATE upstream_servers SET observed_grant_days = ?1 WHERE id = ?2`)
    .bind(days, upstreamId)
    .run()
  return days
}
