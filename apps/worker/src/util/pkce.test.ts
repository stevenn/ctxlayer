import { describe, expect, it } from 'vitest'
import { pkceChallenge, pkceVerifier } from './pkce'

describe('pkceVerifier', () => {
  it('is 43 unreserved chars (RFC 7636 minimum) from 32 random bytes', () => {
    const v = pkceVerifier()
    expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(pkceVerifier()).not.toBe(v)
  })
})

describe('pkceChallenge', () => {
  it('matches the RFC 7636 appendix B test vector', async () => {
    const challenge = await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')
    expect(challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  })

  it('is deterministic and unpadded base64url', async () => {
    const v = pkceVerifier()
    const [a, b] = [await pkceChallenge(v), await pkceChallenge(v)]
    expect(a).toBe(b)
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })
})
