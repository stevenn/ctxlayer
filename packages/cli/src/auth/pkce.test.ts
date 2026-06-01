import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { newPkce, newState } from './pkce'

describe('newPkce', () => {
  it('produces a base64url verifier + matching S256 challenge', () => {
    const { verifier, challenge } = newPkce()
    // base64url alphabet only — no +, /, or = padding.
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/)
    // 32 random bytes → 43 base64url chars.
    expect(verifier).toHaveLength(43)
    // challenge MUST be base64url(sha256(verifier)) per RFC 7636 S256.
    const expected = createHash('sha256')
      .update(verifier)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    expect(challenge).toBe(expected)
  })

  it('is unique per call', () => {
    expect(newPkce().verifier).not.toBe(newPkce().verifier)
  })
})

describe('newState', () => {
  it('returns a base64url string (16 bytes → 22 chars)', () => {
    const s = newState()
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(s).toHaveLength(22)
  })
})
