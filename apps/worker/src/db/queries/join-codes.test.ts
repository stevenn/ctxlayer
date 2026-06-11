import { describe, expect, it } from 'vitest'
import { normalizeCode } from './join-codes'

describe('normalizeCode', () => {
  it('uppercases and strips separators so display + canonical forms hash alike', () => {
    expect(normalizeCode('abcd-efgh-ijkl-mnpq')).toBe('ABCDEFGHIJKLMNPQ')
    expect(normalizeCode('ABCD EFGH')).toBe('ABCDEFGH')
    expect(normalizeCode('  a2c4 ')).toBe('A2C4')
  })

  it('drops any non-alphanumeric noise', () => {
    expect(normalizeCode('a.b_c/d')).toBe('ABCD')
  })
})
