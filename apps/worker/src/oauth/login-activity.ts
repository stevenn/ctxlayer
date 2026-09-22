/**
 * MCP-login expiry policy: idle, not absolute.
 *
 * `workers-oauth-provider` only offers an ABSOLUTE refresh-token lifetime —
 * `grant.expiresAt` is stamped at the authorization-code exchange and the
 * refresh path re-saves that same instant (the token-exchange callback is
 * explicitly forbidden from changing `refreshTokenTTL`). The DCR client
 * record expires the same way. So however diligently a client refreshed, it
 * was logged out on a fixed date: the library's 30 d, then our 90 d.
 *
 * We now pass both TTLs as `undefined` (KV records with no expiration) and
 * own the policy here: a login lives as long as it keeps refreshing, and
 * dies after `MCP_LOGIN_IDLE_DAYS` of silence. `stampTokenExchange` is the
 * "it refreshed" half — the provider calls it on every exchange; the nightly
 * sweep (grant-sweep.ts) is the "it went quiet" half.
 */

import type { Env } from '../env'
import { stampGrantActivity } from '../db/queries/oauth-grant-activity'
import { errMessage } from '../util/errors'

/**
 * How long a login may go without a token exchange before the nightly sweep
 * revokes it. A connected client refreshes roughly hourly (1 h access
 * tokens), so this is "the user has not opened this client in 90 days", not
 * a countdown anyone hits while working.
 */
export const MCP_LOGIN_IDLE_DAYS = 90

/**
 * The provider's `tokenExchangeCallback`. Runs inside the token endpoint, so
 * it must be cheap (one indexed UPSERT) and it must NEVER throw: a ledger
 * write is observability for the sweep, and failing the exchange over it
 * would turn a D1 hiccup into "everyone is logged out". A dropped stamp
 * costs nothing — the next refresh an hour later writes it again, and a
 * grant with no row at all is *seeded* by the sweep rather than revoked.
 *
 * Returns nothing: the callback may rewrite props/TTLs, and we deliberately
 * do neither.
 */
export async function stampTokenExchange(
  env: Env,
  opts: { grantId: string; userId: string; clientId: string },
  now = Math.floor(Date.now() / 1000)
): Promise<void> {
  try {
    await stampGrantActivity(env, {
      grantId: opts.grantId,
      userId: opts.userId,
      clientId: opts.clientId,
      now
    })
  } catch (err) {
    console.warn(`[login-activity] stamp failed for grant ${opts.grantId}:`, errMessage(err))
  }
}
