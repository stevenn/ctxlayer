import { describe, it, expect } from 'vitest'
import { rangeCutoff } from './usage-read'

const DAY = 86400

describe('rangeCutoff', () => {
  it('returns null for the "all" range (no lower bound)', () => {
    expect(rangeCutoff('all')).toBeNull()
  })

  it('is day-aligned to midnight UTC', () => {
    expect(rangeCutoff('1d')! % DAY).toBe(0)
  })

  it('keeps today for 1d and steps back whole days for longer ranges', () => {
    const today = rangeCutoff('1d')!
    // Inclusive-of-today spans: Nd keeps today + the (N-1) prior days.
    expect(rangeCutoff('2d')).toBe(today - 1 * DAY)
    expect(rangeCutoff('7d')).toBe(today - 6 * DAY)
    expect(rangeCutoff('30d')).toBe(today - 29 * DAY)
    expect(rangeCutoff('90d')).toBe(today - 89 * DAY)
  })
})
