import { describe, expect, it } from 'vitest'
import { byteLength, tokenCount } from './tokens'

describe('byteLength', () => {
  it('counts UTF-8 bytes, not code points', () => {
    expect(byteLength('hello')).toBe(5)
    // 'é' is 2 bytes in UTF-8 even though it's one code point.
    expect(byteLength('é')).toBe(2)
    expect(byteLength('')).toBe(0)
  })
})

describe('tokenCount', () => {
  it('returns 0 for the empty string without loading the encoder', () => {
    expect(tokenCount('')).toBe(0)
  })

  it('returns a stable positive count for simple ASCII', () => {
    // cl100k_base happens to encode short ASCII near 1:1 per word.
    // We don't pin the exact count (encoder versions can drift) but
    // it should be small and stable across re-invocations.
    const a = tokenCount('hello world')
    const b = tokenCount('hello world')
    expect(a).toBe(b)
    expect(a).toBeGreaterThan(0)
    expect(a).toBeLessThan(10)
  })
})
