/**
 * Nightly keep-warm for idle user_oauth refresh tokens.
 *
 * Token refresh is otherwise strictly lazy (bearer.ts runs only at session
 * init / reload / admin refresh), so a credential nobody uses for weeks is
 * never exercised — and providers with refresh-token inactivity windows or
 * rotation-family expiry kill it silently during the idle period. The user
 * discovers the death at point-of-need as `needsReauth`. This cron
 * exercises long-idle refresh tokens while they are still alive, and turns
 * the un-preventable death classes (scope changes, revocations, a
 * provider's ABSOLUTE grant lifetime — see `authConfig.grantLifetimeDays`)
 * into next-morning `needsReauth` flags + audit entries instead of mid-task
 * surprises.
 *
 * Deliberately UN-aggressive — every refresh spends a rotating refresh
 * token, so cadence is the safety knob:
 *   - runs once nightly (the 03:00 cron), max KEEP_WARM_BATCH creds/run;
 *   - a credential is due only after KEEP_WARM_IDLE_SECONDS untouched
 *     (`updated_at` moves on every token save, so active creds are
 *     naturally exempt);
 *   - sequential, and each refresh goes through the normal
 *     `resolveUserUpstreamBearer` path — fast-path skip, single-flight
 *     lease (can never race a live session onto the same rotating token),
 *     and the exact same permanent/transient + needsReauth semantics. It
 *     never forces a refresh the lazy path would not make.
 *
 * Scheduling is the job's OWN stamp (`keep_warm_after`, migration 0037),
 * not `updated_at`: most attempts save nothing, so relying on a re-save to
 * leave the due window left the same ~20 credentials due forever — tokens
 * with no expiry and no refresh token (GitHub OAuth apps), or an access
 * token still valid after two idle weeks (Sentry) — re-selected every
 * night at the front of an oldest-first batch, and tallied as "warmed".
 * Every attempt now stamps when to look again, and the due query orders by
 * that stamp, so an attempted credential goes to the back of the queue:
 *   - refreshed / nothing to refresh → a full idle window ahead;
 *   - transient failure (or a throw)  → KEEP_WARM_RETRY_SECONDS, i.e. the
 *     next night, without jumping the queue;
 *   - permanent failure → the reauth flag excludes it until the user
 *     reconnects (it surfaces on /app/upstreams + the audit log).
 */

import type { Env } from '../env'
import {
  countKeepWarmDueCredentials,
  getUserCredentialStatus,
  listKeepWarmDueCredentials,
  setKeepWarmAfter
} from '../db/queries/upstream-credentials'
import { toUpstreamConnection, type UpstreamServerRow, type UpstreamConnection } from '../db/queries/upstreams'
import { resolveUserUpstreamBearer } from './bearer'
import { errMessage } from '../util/errors'

/** A credential is keep-warm due only after this long untouched. */
export const KEEP_WARM_IDLE_SECONDS = 14 * 24 * 60 * 60
/** Max credentials attempted per nightly run. */
export const KEEP_WARM_BATCH = 25
/**
 * Look again this soon after a transient failure. Under 24h on purpose: the
 * stamp is taken from the cron's scheduled time, so a full day would land a
 * hair AFTER tomorrow's run and silently turn "next night" into two.
 */
export const KEEP_WARM_RETRY_SECONDS = 20 * 60 * 60

export type KeepWarmResolver = (
  env: Env,
  row: UpstreamServerRow,
  conn: UpstreamConnection,
  userId: string
) => Promise<string | null>

// A type alias, not an interface: it is handed to the job ledger as a
// `Record<string, unknown>` summary, which needs the implicit index signature.
export type KeepWarmResult = {
  /** Credentials attempted this run (≤ KEEP_WARM_BATCH). */
  due: number
  /** Refresh token exercised: new tokens were saved. The job's actual purpose. */
  refreshed: number
  /**
   * Death detected: the refresh was permanently rejected and the credential
   * is now flagged for reauth. The job working as designed, NOT a failure —
   * it used to be tallied as `failed` and turn the run yellow.
   */
  flagged: number
  /** No usable token and no flag: a transient failure (or a throw). Retried next night. */
  failed: number
  /**
   * Resolved without saving anything — the access token is still valid, or
   * the credential has no refresh token at all. Nothing to keep warm; these
   * used to be reported as "warmed" every single night.
   */
  idle: number
  /** Due credentials this run could not reach. Persistently > 0 ⇒ raise the batch. */
  backlog: number
}

/**
 * Attempt the due credentials; never throws. `resolver` is injectable for
 * tests — production uses the real bearer resolution.
 */
export async function keepWarmUserCredentials(
  env: Env,
  nowSec: number,
  resolver: KeepWarmResolver = resolveUserUpstreamBearer
): Promise<KeepWarmResult> {
  const [due, dueTotal] = await Promise.all([
    listKeepWarmDueCredentials(env, nowSec, KEEP_WARM_IDLE_SECONDS, KEEP_WARM_BATCH),
    countKeepWarmDueCredentials(env, nowSec, KEEP_WARM_IDLE_SECONDS)
  ])
  const result: KeepWarmResult = {
    due: due.length,
    refreshed: 0,
    flagged: 0,
    failed: 0,
    idle: 0,
    backlog: Math.max(0, dueTotal - due.length)
  }
  for (const d of due) {
    let token: string | null = null
    try {
      token = await resolver(env, d.upstream, toUpstreamConnection(d.upstream), d.userId)
    } catch (err) {
      console.error(`[keep-warm] ${d.upstream.slug} (user ${d.userId}): ${errMessage(err)}`)
    }
    // The resolver only reports a token; what it DID is read off the row: a
    // real refresh re-saved the tokens (`updated_at` moved), a permanent
    // rejection set the reauth flag. Tallied once, after the bookkeeping.
    let outcome: 'refreshed' | 'idle' | 'flagged' | 'failed' = 'failed'
    try {
      const after = await getUserCredentialStatus(env, d.userId, d.upstream.id)
      if (token !== null) {
        outcome =
          after.updatedAt !== null && after.updatedAt !== d.credUpdatedAt ? 'refreshed' : 'idle'
      } else if (after.needsReauth) {
        outcome = 'flagged'
      }
      await setKeepWarmAfter(
        env,
        d.userId,
        d.upstream.id,
        nowSec + (outcome === 'failed' ? KEEP_WARM_RETRY_SECONDS : KEEP_WARM_IDLE_SECONDS)
      )
    } catch (err) {
      // Bookkeeping failed, not the warm itself: report it as a failure so
      // the run shows partial. The stamp is unwritten, so it stays due.
      outcome = 'failed'
      console.error(
        `[keep-warm] ${d.upstream.slug} (user ${d.userId}): bookkeeping: ${errMessage(err)}`
      )
    }
    result[outcome]++
  }
  return result
}
