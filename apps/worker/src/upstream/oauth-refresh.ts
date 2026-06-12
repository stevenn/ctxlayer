/**
 * Single-flight wrapper around a user_oauth token refresh.
 *
 * A user with multiple concurrent MCP sessions/devices runs one Durable
 * Object per session; each resolves the same (user, upstream) credential
 * independently. Without coordination, two near-expiry refreshes would both
 * POST the same rotating refresh_token — and providers that detect reuse
 * (Microsoft Entra, GitLab, …) revoke the whole token family, silently
 * logging the user out. We serialize the refresh through a short D1 lease
 * (`acquireRefreshLease`): the winner refreshes; losers wait briefly for the
 * rotated token to land rather than spending the refresh_token again.
 *
 * Applies to both the DCR path (SDK `auth()`) and the static/Entra path —
 * `bearer.ts` decides which refresh to run; this module only serializes it.
 */

import type { Env } from '../env'
import { acquireRefreshLease } from '../db/queries/upstream-credentials'

// The lease auto-expires this many seconds after it's claimed, so a crashed
// or slow holder never deadlocks the credential. Sized for a token-endpoint
// round-trip plus margin. After a *successful* refresh the rotated token is
// fresh, so the fast path serves everyone and no one re-takes the lease; the
// only effect of not releasing early is that a *failed* refresh won't be
// retried for up to this long — which is desirable back-pressure.
const LEASE_TTL_S = 20
// A loser polls this many times (× the interval) for the winner's rotated
// token before giving up and returning whatever is stored.
const WAIT_ITERS = 5
const WAIT_INTERVAL_MS = 400

export interface RefreshHandlers {
  /**
   * Perform the refresh (POST + persist) and return the new access token, or
   * null when the refresh was rejected. Only the lease winner runs this.
   */
  refresh: () => Promise<string | null>
  /** Re-read the stored access token (another caller may have refreshed it). */
  readAccessToken: () => Promise<string | null>
  /** True once a non-near-expiry access token is stored. */
  isFresh: () => Promise<boolean>
}

export async function singleFlightRefresh(
  env: Env,
  userId: string,
  upstreamId: string,
  h: RefreshHandlers
): Promise<string | null> {
  if (await acquireRefreshLease(env, userId, upstreamId, LEASE_TTL_S)) {
    return h.refresh()
  }
  // Another session/device holds the lease. Wait for its rotated token to
  // land instead of POSTing the same refresh_token a second time (which
  // would trip provider refresh-token-reuse revocation).
  for (let i = 0; i < WAIT_ITERS; i++) {
    await delay(WAIT_INTERVAL_MS)
    if (await h.isFresh()) return h.readAccessToken()
  }
  // Holder still working, or its refresh failed: return whatever is stored
  // now. No worse than the pre-lease behaviour, and never a duplicate POST.
  return h.readAccessToken()
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
