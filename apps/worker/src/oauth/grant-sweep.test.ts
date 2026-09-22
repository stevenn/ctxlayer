import { describe, it, expect } from 'vitest'
import { planGrantSweep } from './grant-sweep'
import type { GrantRef } from './client-grants'
import type { GrantActivityRow } from '../db/queries/oauth-grant-activity'

const NOW = 1_800_000_000
const DAY = 86400
const CUTOFF = NOW - 90 * DAY

const grant = (id: string, userId = 'u1'): GrantRef => ({
  id,
  userId,
  clientId: `c-${id}`,
  createdAt: NOW - 200 * DAY,
  user: { id: userId, email: `${userId}@test.example`, name: null }
})

const row = (grantId: string, lastRefreshAt: number, userId = 'u1'): GrantActivityRow => ({
  grantId,
  userId,
  clientId: `c-${grantId}`,
  createdAt: NOW - 200 * DAY,
  lastRefreshAt
})

describe('planGrantSweep', () => {
  it('leaves a grant alone while it keeps refreshing, however old it is', () => {
    // Authorized 200 days ago, refreshed an hour ago: the whole point.
    const plan = planGrantSweep([grant('g1')], [row('g1', NOW - 3600)], CUTOFF)
    expect(plan).toEqual({ seed: [], revoke: [], pruneRows: [] })
  })

  it('revokes a grant that went quiet past the idle window', () => {
    const plan = planGrantSweep([grant('g1')], [row('g1', NOW - 91 * DAY)], CUTOFF)
    expect(plan.revoke.map((r) => r.grantId)).toEqual(['g1'])
    expect(plan.pruneRows).toEqual([])
  })

  it('does not revoke a grant that is idle but still inside the window', () => {
    const plan = planGrantSweep([grant('g1')], [row('g1', NOW - 89 * DAY)], CUTOFF)
    expect(plan.revoke).toEqual([])
  })

  it('seeds an untracked grant instead of revoking it', () => {
    // Grants that predate the ledger have no stamp; they must get a full
    // idle window, never an immediate revocation.
    const plan = planGrantSweep([grant('g-old')], [], CUTOFF)
    expect(plan.seed.map((g) => g.id)).toEqual(['g-old'])
    expect(plan.revoke).toEqual([])
  })

  it('prunes rows whose grant is gone without counting them as revoked', () => {
    // Revoked by suspend/delete: already dead, so it is bookkeeping —
    // reporting it as an idle revocation would overstate what the job did.
    const plan = planGrantSweep([], [row('g-gone', NOW - 200 * DAY)], CUTOFF)
    expect(plan.pruneRows).toEqual(['g-gone'])
    expect(plan.revoke).toEqual([])
  })

  it('handles a mixed fleet in one pass', () => {
    const grants = [grant('live'), grant('quiet', 'u2'), grant('new')]
    const ledger = [
      row('live', NOW - DAY),
      row('quiet', NOW - 120 * DAY, 'u2'),
      row('vanished', NOW - DAY)
    ]
    const plan = planGrantSweep(grants, ledger, CUTOFF)
    expect(plan.seed.map((g) => g.id)).toEqual(['new'])
    expect(plan.revoke.map((r) => r.grantId)).toEqual(['quiet'])
    expect(plan.revoke[0]?.userId).toBe('u2')
    expect(plan.pruneRows).toEqual(['vanished'])
  })
})
