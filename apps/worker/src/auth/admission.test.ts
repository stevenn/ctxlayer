import { describe, expect, it, vi, beforeEach } from 'vitest'

// The resolver pulls invite + join-code state from D1; mock those modules so
// the test drives the branch logic directly. passesDomainPrefilter is left
// REAL — for a Google identity it's a pure `hd` claim check (no network).
vi.mock('../db/queries/invites', () => ({ findUnredeemedInvite: vi.fn() }))
vi.mock('../db/queries/join-codes', () => ({
  findRedeemableJoinCode: vi.fn(),
  bumpJoinCodeUses: vi.fn()
}))

import { parseAccessPolicy, resolveAdmission } from './admission'
import { findUnredeemedInvite } from '../db/queries/invites'
import { findRedeemableJoinCode, bumpJoinCodeUses } from '../db/queries/join-codes'
import type { Env } from '../env'

const mockedInvite = vi.mocked(findUnredeemedInvite)
const mockedFindCode = vi.mocked(findRedeemableJoinCode)
const mockedBump = vi.mocked(bumpJoinCodeUses)

function env(over: Partial<Env> = {}): Env {
  return {
    ALLOWED_GOOGLE_EMAILS: '',
    ALLOWED_GOOGLE_HD: '',
    ALLOWED_GITHUB_USERS: '',
    ALLOWED_GITHUB_ORG: '',
    ACCESS_POLICY: undefined,
    DB: {} as Env['DB'],
    ...over
  } as Env
}

const googleId = { idp: 'google' as const, email: 'sam@visma.com', hd: 'visma.com' }

beforeEach(() => {
  vi.clearAllMocks()
  mockedInvite.mockResolvedValue(null)
})

describe('parseAccessPolicy', () => {
  it('defaults to open_domain when unset or unknown', () => {
    expect(parseAccessPolicy(env())).toBe('open_domain')
    expect(parseAccessPolicy(env({ ACCESS_POLICY: 'nonsense' }))).toBe('open_domain')
  })
  it('reads request / invite case-insensitively', () => {
    expect(parseAccessPolicy(env({ ACCESS_POLICY: 'request' }))).toBe('request')
    expect(parseAccessPolicy(env({ ACCESS_POLICY: ' INVITE ' }))).toBe('invite')
  })
})

describe('resolveAdmission — explicit allowlist (break-glass)', () => {
  it('admits an explicit email as active under any policy, before any DB lookup', async () => {
    const r = await resolveAdmission({
      identity: googleId,
      env: env({ ALLOWED_GOOGLE_EMAILS: 'sam@visma.com', ACCESS_POLICY: 'invite' })
    })
    expect(r).toEqual({ kind: 'admit', status: 'active' })
    expect(mockedInvite).not.toHaveBeenCalled()
  })
})

describe('resolveAdmission — invite', () => {
  it('admits an invited email as active and reports the invite to redeem', async () => {
    mockedInvite.mockResolvedValue({ id: 'inv1' })
    const r = await resolveAdmission({ identity: googleId, env: env({ ACCESS_POLICY: 'invite' }) })
    expect(r).toEqual({ kind: 'admit', status: 'active', redeemInviteId: 'inv1' })
  })
})

describe('resolveAdmission — join code', () => {
  it('admits per the code on_redeem and bumps the use', async () => {
    mockedFindCode.mockResolvedValue({ ok: true, id: 'jc1', onRedeem: 'pending' })
    mockedBump.mockResolvedValue(true)
    const r = await resolveAdmission({
      identity: googleId,
      joinCode: 'abcd-efgh',
      env: env({ ACCESS_POLICY: 'invite' })
    })
    expect(r).toEqual({ kind: 'admit', status: 'pending' })
    expect(mockedBump).toHaveBeenCalledWith(expect.anything(), 'jc1')
  })

  it('rejects when the use bump loses the race (exhausted)', async () => {
    mockedFindCode.mockResolvedValue({ ok: true, id: 'jc1', onRedeem: 'active' })
    mockedBump.mockResolvedValue(false)
    const r = await resolveAdmission({ identity: googleId, joinCode: 'x', env: env() })
    expect(r).toEqual({ kind: 'reject', reason: 'invalid_join_code' })
  })

  it('propagates an invalid / expired code reason', async () => {
    mockedFindCode.mockResolvedValue({ ok: false, reason: 'code_expired' })
    const r = await resolveAdmission({ identity: googleId, joinCode: 'x', env: env() })
    expect(r).toEqual({ kind: 'reject', reason: 'code_expired' })
    expect(mockedBump).not.toHaveBeenCalled()
  })

  // A code use must only be consumed when the code actually improves the
  // outcome — otherwise anyone who learns a code can exhaust max_uses by
  // appending ?join= to ordinary sign-ins of already-admissible members.
  it('does NOT burn a use for a domain member admitted active anyway (open_domain)', async () => {
    const r = await resolveAdmission({
      identity: googleId,
      joinCode: 'abcd-efgh',
      env: env({ ALLOWED_GOOGLE_HD: 'visma.com' })
    })
    expect(r).toEqual({ kind: 'admit', status: 'active' })
    expect(mockedFindCode).not.toHaveBeenCalled()
    expect(mockedBump).not.toHaveBeenCalled()
  })

  it('does NOT burn a use when the code yields pending and policy already grants pending', async () => {
    mockedFindCode.mockResolvedValue({ ok: true, id: 'jc1', onRedeem: 'pending' })
    const r = await resolveAdmission({
      identity: googleId,
      joinCode: 'abcd-efgh',
      env: env({ ALLOWED_GOOGLE_HD: 'visma.com', ACCESS_POLICY: 'request' })
    })
    expect(r).toEqual({ kind: 'admit', status: 'pending' })
    expect(mockedBump).not.toHaveBeenCalled()
  })

  it('burns a use when the code upgrades a pending admission to active', async () => {
    mockedFindCode.mockResolvedValue({ ok: true, id: 'jc1', onRedeem: 'active' })
    mockedBump.mockResolvedValue(true)
    const r = await resolveAdmission({
      identity: googleId,
      joinCode: 'abcd-efgh',
      env: env({ ALLOWED_GOOGLE_HD: 'visma.com', ACCESS_POLICY: 'request' })
    })
    expect(r).toEqual({ kind: 'admit', status: 'active' })
    expect(mockedBump).toHaveBeenCalledWith(expect.anything(), 'jc1')
  })

  it('falls back to the codeless outcome when the code is invalid but policy admits', async () => {
    mockedFindCode.mockResolvedValue({ ok: false, reason: 'code_expired' })
    const r = await resolveAdmission({
      identity: googleId,
      joinCode: 'stale',
      env: env({ ACCESS_POLICY: 'request' })
    })
    expect(r).toEqual({ kind: 'admit', status: 'pending' })
    expect(mockedBump).not.toHaveBeenCalled()
  })

  it('falls back to the codeless outcome when the bump loses the race but policy admits', async () => {
    mockedFindCode.mockResolvedValue({ ok: true, id: 'jc1', onRedeem: 'active' })
    mockedBump.mockResolvedValue(false)
    const r = await resolveAdmission({
      identity: googleId,
      joinCode: 'x',
      env: env({ ACCESS_POLICY: 'request' })
    })
    expect(r).toEqual({ kind: 'admit', status: 'pending' })
  })
})

describe('resolveAdmission — domain pre-filter by policy', () => {
  it('open_domain: hd match admits active', async () => {
    const r = await resolveAdmission({
      identity: googleId,
      env: env({ ALLOWED_GOOGLE_HD: 'visma.com' })
    })
    expect(r).toEqual({ kind: 'admit', status: 'active' })
  })

  it('request + configured domain: a member lands pending', async () => {
    const r = await resolveAdmission({
      identity: googleId,
      env: env({ ALLOWED_GOOGLE_HD: 'visma.com', ACCESS_POLICY: 'request' })
    })
    expect(r).toEqual({ kind: 'admit', status: 'pending' })
  })

  it('request + configured domain: an outsider is rejected (members-only queue)', async () => {
    const r = await resolveAdmission({
      identity: { ...googleId, hd: 'other.com' },
      env: env({ ALLOWED_GOOGLE_HD: 'visma.com', ACCESS_POLICY: 'request' })
    })
    expect(r).toEqual({ kind: 'reject', reason: 'access_denied' })
  })

  it('request + NO domain configured: anyone who can sign in lands pending (open queue)', async () => {
    const r = await resolveAdmission({
      identity: { idp: 'google', email: 'stranger@anywhere.com' },
      env: env({ ACCESS_POLICY: 'request' })
    })
    expect(r).toEqual({ kind: 'admit', status: 'pending' })
  })

  it('invite: hd match alone is not enough', async () => {
    const r = await resolveAdmission({
      identity: googleId,
      env: env({ ALLOWED_GOOGLE_HD: 'visma.com', ACCESS_POLICY: 'invite' })
    })
    expect(r).toEqual({ kind: 'reject', reason: 'invite_required' })
  })
})

describe('resolveAdmission — no match, reason shaped by policy', () => {
  it('open_domain with no allowlist configured → *_disabled', async () => {
    const r = await resolveAdmission({ identity: googleId, env: env() })
    expect(r).toEqual({ kind: 'reject', reason: 'google_disabled' })
  })

  it('open_domain with a configured-but-mismatched hd → wrong_domain', async () => {
    const r = await resolveAdmission({
      identity: { ...googleId, hd: 'other.com' },
      env: env({ ALLOWED_GOOGLE_HD: 'visma.com' })
    })
    expect(r).toEqual({ kind: 'reject', reason: 'wrong_domain' })
  })

  it('invite with no match → invite_required', async () => {
    const r = await resolveAdmission({ identity: googleId, env: env({ ACCESS_POLICY: 'invite' }) })
    expect(r).toEqual({ kind: 'reject', reason: 'invite_required' })
  })
})
