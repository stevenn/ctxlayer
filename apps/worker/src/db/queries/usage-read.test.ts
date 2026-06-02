import { describe, it, expect } from 'vitest'
import { rangeCutoff } from './usage-read'

const DAY = 86400

describe('rangeCutoff', () => {
  it('returns null for the "all" range, any offset', () => {
    expect(rangeCutoff('all', 0)).toBeNull()
    expect(rangeCutoff('all', 7200)).toBeNull()
  })

  it('steps back one whole day per range step (fixed offset)', () => {
    const O = 7200
    const d1 = rangeCutoff('1d', O)!
    // Inclusive-of-today spans: Nd keeps today + the (N-1) prior local days.
    expect(rangeCutoff('2d', O)).toBe(d1 - DAY)
    expect(rangeCutoff('7d', O)).toBe(d1 - 6 * DAY)
    expect(rangeCutoff('30d', O)).toBe(d1 - 29 * DAY)
    expect(rangeCutoff('90d', O)).toBe(d1 - 89 * DAY)
  })

  it("1d (UTC) includes today's rollup and excludes yesterday's", () => {
    const todayUtc = Math.floor(Date.now() / 1000 / DAY) * DAY
    const cut = rangeCutoff('1d', 0)!
    // A rollup's `day` (UTC midnight) passes `day >= cut`: today's does,
    // yesterday's does not.
    expect(todayUtc).toBeGreaterThanOrEqual(cut)
    expect(todayUtc - DAY).toBeLessThan(cut)
  })
})
