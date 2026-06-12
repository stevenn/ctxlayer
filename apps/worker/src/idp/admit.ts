/**
 * Shared admission step for the IdP callbacks. Runs the policy resolver,
 * upserts the user, redeems any invite, and enforces the stored lifecycle
 * status — so a suspended / pending account can't slip through either the
 * SPA-session branch (5b) or the MCP-grant branch (5a). Both github.ts and
 * google.ts funnel through here after they've verified the identity.
 */

import type { Env } from '../env'
import type { AdmissionIdentity } from '../util/allowlist'
import { resolveAdmission } from '../auth/admission'
import { upsertUser, type UpsertUserInput, type UserRow } from '../db/queries/users'
import { markInviteRedeemed } from '../db/queries/invites'
import { audit } from '../audit/log'
import { clearStateCookie, signInErrorRedirect, type ErrorReason } from './common'

export type AdmitOutcome = { user: UserRow } | { response: Response }

/** A /sign-in error redirect that also clears the IdP state cookie. */
function redirectClearingState(env: Env, reason: ErrorReason): Response {
  const res = signInErrorRedirect(env, reason)
  const headers = new Headers(res.headers)
  headers.append('Set-Cookie', clearStateCookie())
  return new Response(null, { status: res.status, headers })
}

export async function admitOrReject(
  env: Env,
  identity: AdmissionIdentity,
  upsertInput: UpsertUserInput,
  joinCode: string | undefined
): Promise<AdmitOutcome> {
  const decision = await resolveAdmission({ identity, joinCode, env })
  if (decision.kind === 'reject') return { response: redirectClearingState(env, decision.reason) }

  const { user, promotedToAdmin } = await upsertUser(env, upsertInput, decision.status)
  // Audit-log the ADMIN_EMAILS-driven promotion. Fires on every sign-in
  // by an allowlisted admin email (no prior-role read in the upsert);
  // readers can dedupe downstream if it matters.
  if (promotedToAdmin) {
    await audit(env, {
      actorId: user.id,
      action: 'user.admin_promote',
      target: user.id,
      meta: { via: 'ADMIN_EMAILS' }
    })
  }
  if (decision.redeemInviteId) await markInviteRedeemed(env, decision.redeemInviteId, user.id)

  // Stored status wins for an existing user: a re-sign-in by a suspended or
  // still-pending account must not get a session, even when admission would
  // have admitted a fresh identity.
  if (user.status === 'suspended') return { response: redirectClearingState(env, 'suspended') }
  if (user.status === 'pending') return { response: redirectClearingState(env, 'pending_approval') }
  return { user }
}
