/**
 * Nightly reconciliation of the login-activity ledger against the grants in
 * KV — the "it went quiet" half of the sliding session (see
 * oauth/login-activity.ts; the ledger is migration 0038).
 *
 * Three things happen per run, in this order:
 *
 *   1. SEED — a live grant with no ledger row gets one, stamped now. Grants
 *      that predate the ledger (and any whose stamps were lost to a D1
 *      outage) therefore get a full idle window to prove they are alive.
 *      A missing row can never cause a revocation.
 *   2. REVOKE — a ledger row that has not been stamped for `idleDays` means
 *      the client stopped refreshing that long ago: revoke the grant, drop
 *      the row. The user's next connect does a normal login.
 *   3. PRUNE — a ledger row whose grant is gone from KV (revoked by
 *      suspend/delete, or by a previous run) is deleted, which is what keeps
 *      the table the size of the live-grant set.
 *
 * Fail-closed, same stance as the orphan-client prune: if ANY per-user grant
 * read failed, the picture is incomplete — a live grant could look absent —
 * so the run seeds nothing and revokes nothing and reports it. Deleting rows
 * or revoking logins on a transient KV error is exactly the "silent daily
 * re-login" failure this whole change exists to remove.
 *
 * Known gap: enumeration fans out over ctxlayer's USERS, so a grant held by
 * a hard-deleted user is invisible here and, with no KV expiration left to
 * collect it, would sit in KV forever. Account deletion revokes every grant
 * up front (`revokeAllUserGrants`), so this only bites if that best-effort
 * call partially failed — it reports `complete: false` when it does.
 */

import type { Env } from '../env'
import type { OAuthHelpers } from './client-grants'
import { listAllGrants, type GrantRef } from './client-grants'
import {
  deleteGrantActivity,
  listGrantActivity,
  seedGrantActivity,
  type GrantActivityRow
} from '../db/queries/oauth-grant-activity'
import { MCP_LOGIN_IDLE_DAYS } from './login-activity'
import { errMessage } from '../util/errors'

const SECONDS_PER_DAY = 86400

export interface GrantSweepPlan {
  /** Live grants the ledger has never seen. */
  seed: GrantRef[]
  /** Ledger rows whose grant went quiet past the idle window. */
  revoke: GrantActivityRow[]
  /** Ledger rows whose grant no longer exists in KV. */
  pruneRows: string[]
}

/**
 * Pure planner (exported for tests). `cutoff` is the oldest
 * `last_refresh_at` still considered alive — a row at or below it is idle.
 */
export function planGrantSweep(
  grants: readonly GrantRef[],
  ledger: readonly GrantActivityRow[],
  cutoff: number
): GrantSweepPlan {
  const byGrantId = new Map(ledger.map((r) => [r.grantId, r]))
  const live = new Set(grants.map((g) => g.id))
  const seed = grants.filter((g) => !byGrantId.has(g.id))
  const revoke: GrantActivityRow[] = []
  const pruneRows: string[] = []
  for (const row of ledger) {
    // A row whose grant is gone is already dead — prune it, never
    // "revoke" it (that would double-count a suspend/delete as an
    // idle expiry in the ledger summary).
    if (!live.has(row.grantId)) pruneRows.push(row.grantId)
    else if (row.lastRefreshAt <= cutoff) revoke.push(row)
  }
  return { seed, revoke, pruneRows }
}

export interface GrantSweepResult {
  /** Live grants seen in KV. */
  grants: number
  /** Ledger rows read. */
  tracked: number
  seeded: number
  /** Idle grants revoked. */
  revoked: number
  /** Rows dropped because their grant was already gone. */
  pruned: number
  /** revokeGrant calls that threw. */
  failed: number
  /** True when we changed nothing because the grant read was incomplete. */
  skippedIncompleteIndex: boolean
}

const EMPTY: GrantSweepResult = {
  grants: 0,
  tracked: 0,
  seeded: 0,
  revoked: 0,
  pruned: 0,
  failed: 0,
  skippedIncompleteIndex: true
}

export async function sweepIdleGrants(
  env: Env,
  helpers: OAuthHelpers,
  opts: { idleDays?: number; now?: number } = {}
): Promise<GrantSweepResult> {
  const now = opts.now ?? Math.floor(Date.now() / 1000)
  const idleDays = opts.idleDays ?? MCP_LOGIN_IDLE_DAYS
  const cutoff = now - idleDays * SECONDS_PER_DAY

  const [{ grants, complete }, ledger] = await Promise.all([
    listAllGrants(env, helpers),
    listGrantActivity(env)
  ])
  if (!complete) return { ...EMPTY, grants: grants.length, tracked: ledger.length }

  const plan = planGrantSweep(grants, ledger, cutoff)
  const seeded = await seedGrantActivity(
    env,
    plan.seed.map((g) => ({
      grantId: g.id,
      userId: g.userId,
      clientId: g.clientId,
      createdAt: g.createdAt
    })),
    now
  )

  let revoked = 0
  let failed = 0
  const revokedIds: string[] = []
  for (const row of plan.revoke) {
    try {
      await helpers.revokeGrant(row.grantId, row.userId)
      revoked++
      revokedIds.push(row.grantId)
    } catch (err) {
      failed++
      console.warn(`[grant-sweep] revokeGrant(${row.grantId}) failed:`, errMessage(err))
    }
  }
  // Only rows we actually revoked are dropped; a failed revoke keeps its row
  // so the next run retries it instead of losing the grant from the ledger.
  await deleteGrantActivity(env, [...plan.pruneRows, ...revokedIds])

  return {
    grants: grants.length,
    tracked: ledger.length,
    seeded,
    revoked,
    pruned: plan.pruneRows.length,
    failed,
    skippedIncompleteIndex: false
  }
}
