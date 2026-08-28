/**
 * Nightly keep-warm for idle user_oauth refresh tokens.
 *
 * Token refresh is otherwise strictly lazy (bearer.ts runs only at session
 * init / reload / admin refresh), so a credential nobody uses for weeks is
 * never exercised — and providers with refresh-token inactivity windows or
 * rotation-family expiry kill it silently during the idle period. The user
 * discovers the death at point-of-need as `needsReauth`. This cron
 * exercises long-idle refresh tokens while they are still alive, and turns
 * the un-preventable death classes (scope changes, revocations) into
 * next-morning `needsReauth` flags + audit entries instead of mid-task
 * surprises.
 *
 * Deliberately UN-aggressive — every refresh spends a rotating refresh
 * token, so cadence is the safety knob:
 *   - runs once nightly (the 03:00 cron), max KEEP_WARM_BATCH creds/run;
 *   - a credential is due only after KEEP_WARM_IDLE_SECONDS untouched
 *     (`updated_at` moves on every token save, so active creds are
 *     naturally exempt and each cred is warmed at most ~once per window);
 *   - sequential, and each refresh goes through the normal
 *     `resolveUserUpstreamBearer` path — fast-path skip, single-flight
 *     lease (can never race a live session onto the same rotating token),
 *     and the exact same permanent/transient + needsReauth semantics.
 *
 * Outcome mechanics: success re-saves tokens (touches `updated_at` → next
 * due in a window); a transient failure leaves `updated_at` alone (retried
 * the NEXT night, not in a window); a permanent failure flags reauth,
 * which excludes the credential from future runs and surfaces it on
 * /app/upstreams + the audit log.
 */

import type { Env } from '../env'
import { listKeepWarmDueCredentials } from '../db/queries/upstream-credentials'
import { toUpstreamConnection, type UpstreamServerRow, type UpstreamConnection } from '../db/queries/upstreams'
import { resolveUserUpstreamBearer } from './bearer'
import { errMessage } from '../util/errors'

/** A credential is keep-warm due only after this long untouched. */
export const KEEP_WARM_IDLE_SECONDS = 14 * 24 * 60 * 60
/** Max credentials refreshed per nightly run. */
export const KEEP_WARM_BATCH = 25

export type KeepWarmResolver = (
  env: Env,
  row: UpstreamServerRow,
  conn: UpstreamConnection,
  userId: string
) => Promise<string | null>

/**
 * Refresh the due credentials; never throws. `resolver` is injectable for
 * tests — production uses the real bearer resolution.
 */
export async function keepWarmUserCredentials(
  env: Env,
  nowSec: number,
  resolver: KeepWarmResolver = resolveUserUpstreamBearer
): Promise<{ due: number; warmed: number; failed: number }> {
  const due = await listKeepWarmDueCredentials(env, nowSec, KEEP_WARM_IDLE_SECONDS, KEEP_WARM_BATCH)
  let warmed = 0
  let failed = 0
  for (const d of due) {
    try {
      const conn = toUpstreamConnection(d.upstream)
      const token = await resolver(env, d.upstream, conn, d.userId)
      if (token) warmed++
      else failed++
    } catch (err) {
      failed++
      console.error(`[keep-warm] ${d.upstream.slug} (user ${d.userId}): ${errMessage(err)}`)
    }
  }
  return { due: due.length, warmed, failed }
}
