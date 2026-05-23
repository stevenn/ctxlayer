import { describe, expect, it } from 'vitest'
import { constantTimeEqual, newCsrfToken } from './csrf'

describe('constantTimeEqual', () => {
  it('returns true for identical strings', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true)
  })

  it('returns false for length mismatch', () => {
    expect(constantTimeEqual('abc', 'abcd')).toBe(false)
  })

  it('returns false for single-char mismatch at any position', () => {
    expect(constantTimeEqual('abcde', 'abcdf')).toBe(false)
    expect(constantTimeEqual('abcde', 'Xbcde')).toBe(false)
    expect(constantTimeEqual('abcde', 'abXde')).toBe(false)
  })

  it('returns false for empty vs non-empty', () => {
    expect(constantTimeEqual('', 'a')).toBe(false)
  })

  it('returns true for two empty strings', () => {
    expect(constantTimeEqual('', '')).toBe(true)
  })
})

describe('newCsrfToken', () => {
  it('produces a non-empty url-safe token', () => {
    const t = newCsrfToken()
    expect(t.length).toBeGreaterThan(20)
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('produces different tokens on each call', () => {
    const a = newCsrfToken()
    const b = newCsrfToken()
    expect(a).not.toBe(b)
  })
})
