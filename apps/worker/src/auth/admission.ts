/**
 * Admission resolver (plan L §5). Sits between "identity verified by the
 * IdP" and "upsert the user". Federate authentication, keep authorization
 * local: the IdP only proves control of an email; whether that identity may
 * enter THIS tenant is decided entirely here.
 *
 * Layered, in priority order:
 *   a. explicit per-user env allowlist  -> active (break-glass, any policy)
 *   b. an unredeemed invite for the email -> active
 *   c. a valid join code (consumes a use) -> active | pending (per code)
 *   d. domain/org pre-filter             -> active (open_domain) | pending (request)
 *   e. otherwise                         -> reject (reason shaped by policy)
 *
 * Side effects: a join code's use counter is bumped here (atomic, race-safe)
 * so the max-uses ceiling holds. An invite is reported back via
 * `redeemInviteId` for the caller to mark redeemed once it has the user id.
 */

import type { Env } from '../env'
import type { AccessPolicy, UserStatus } from '@ctxlayer/shared'
import type { ErrorReason } from '../idp/common'
import {
  isExplicitlyAllowlisted,
  idpAllowlistConfigured,
  domainPrefilterConfigured,
  passesDomainPrefilter,
  type AdmissionIdentity
} from '../util/allowlist'
import { findUnredeemedInvite } from '../db/queries/invites'
import { bumpJoinCodeUses, findRedeemableJoinCode } from '../db/queries/join-codes'

export type AdmissionResult =
  | { kind: 'admit'; status: UserStatus; redeemInviteId?: string }
  | { kind: 'reject'; reason: ErrorReason }

export function parseAccessPolicy(env: Env): AccessPolicy {
  const v = (env.ACCESS_POLICY ?? '').trim().toLowerCase()
  return v === 'request' || v === 'invite' ? v : 'open_domain'
}

export async function resolveAdmission(args: {
  identity: AdmissionIdentity
  joinCode?: string
  env: Env
}): Promise<AdmissionResult> {
  const { identity, joinCode, env } = args
  const policy = parseAccessPolicy(env)

  // a. Explicit per-user allowlist — break-glass, admits under any policy.
  if (isExplicitlyAllowlisted(identity, env)) return { kind: 'admit', status: 'active' }

  // b. Invited email. The grant is explicit, so it overrides domain/policy.
  const invite = await findUnredeemedInvite(env, identity.email)
  if (invite) return { kind: 'admit', status: 'active', redeemInviteId: invite.id }

  // c. Join code carried through the IdP dance — evaluated AGAINST the
  //    codeless outcome first, so a use is only consumed when the code
  //    actually improves admission. Otherwise anyone who learns a code can
  //    exhaust its max_uses by appending ?join= to ordinary sign-ins of
  //    members who'd be admitted anyway.
  if (joinCode && joinCode.trim()) {
    const without = await policyAdmission(identity, env, policy)
    if (without.kind === 'admit' && without.status === 'active') return without

    const r = await findRedeemableJoinCode(env, joinCode, identity.email)
    if (!r.ok) {
      // Invalid/expired code: fall back to whatever the policy grants on its
      // own; reject with the code-specific reason only when the code was
      // their sole way in.
      return without.kind === 'admit' ? without : { kind: 'reject', reason: r.reason }
    }
    if (without.kind === 'admit' && r.onRedeem === 'pending') {
      // They'd land pending either way — don't burn a use for nothing.
      return without
    }
    // Bump the use atomically so a racing redemption can't blow past
    // max_uses; the loser of the race falls back to the codeless outcome.
    const won = await bumpJoinCodeUses(env, r.id)
    if (!won) {
      return without.kind === 'admit' ? without : { kind: 'reject', reason: 'invalid_join_code' }
    }
    return { kind: 'admit', status: r.onRedeem }
  }

  return policyAdmission(identity, env, policy)
}

/**
 * d/e. Policy-specific admission for an authenticated-but-not-explicitly-
 * granted identity (no allowlist hit, no invite, no join code applied). The
 * domain/org pre-filter is only evaluated (and only hits the network for
 * GitHub) when a boundary is actually configured.
 */
async function policyAdmission(
  identity: AdmissionIdentity,
  env: Env,
  policy: AccessPolicy
): Promise<AdmissionResult> {
  const domainConfigured = domainPrefilterConfigured(identity.idp, env)
  const domainOk = domainConfigured ? await passesDomainPrefilter(identity, env) : false

  if (policy === 'request') {
    // `request` opens an admin-approval queue. Members-only when an org/domain
    // is configured (outsiders rejected); otherwise OPEN — anyone who can sign
    // in lands `pending` for an admin to approve from the Users › Pending list.
    if (!domainConfigured || domainOk) return { kind: 'admit', status: 'pending' }
    return { kind: 'reject', reason: 'access_denied' }
  }

  if (policy === 'invite') {
    // explicit allowlist / invite / join code are handled by the caller;
    // domain membership alone never admits under invite.
    return { kind: 'reject', reason: 'invite_required' }
  }

  // open_domain (legacy): domain membership admits as active.
  if (domainOk) return { kind: 'admit', status: 'active' }
  // Preserve the legacy disabled / wrong-domain / not-in-org reasons (also a UX
  // signal for users hitting the wrong IdP — see the CLAUDE.md allowlist gotcha).
  if (!idpAllowlistConfigured(identity.idp, env)) {
    return { kind: 'reject', reason: identity.idp === 'github' ? 'github_disabled' : 'google_disabled' }
  }
  return { kind: 'reject', reason: identity.idp === 'github' ? 'not_in_org' : 'wrong_domain' }
}
