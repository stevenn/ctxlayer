import { describe, expect, it } from 'vitest'
import { b64urlDecode, b64urlEncode, randomToken } from './base64url'

describe('b64urlEncode / b64urlDecode', () => {
  it('encodes with the url-safe alphabet, unpadded', () => {
    // 0xfb 0xef 0xff forces '+' and '/' in standard base64 ("++//" family).
    expect(b64urlEncode(new Uint8Array([0xfb, 0xef, 0xff]))).toBe('--__')
    expect(b64urlEncode(new Uint8Array([0xfb, 0xef, 0xff]))).not.toContain('=')
  })

  it('round-trips every padding length (len % 4 of 0, 2, 3)', () => {
    for (const n of [0, 1, 2, 3, 4, 5, 31, 32, 33]) {
      const bytes = new Uint8Array(n)
      for (let i = 0; i < n; i++) bytes[i] = (i * 37 + 5) % 256
      expect(b64urlDecode(b64urlEncode(bytes))).toEqual(bytes)
    }
  })

  it('decodes known vectors byte-exactly', () => {
    expect(b64urlDecode('AA')).toEqual(new Uint8Array([0]))
    expect(b64urlDecode('_w')).toEqual(new Uint8Array([0xff]))
    expect(new TextDecoder().decode(b64urlDecode('aGVsbG8'))).toBe('hello')
  })
})

describe('randomToken', () => {
  it('emits only base64url characters and defaults to 32 bytes (43 chars)', () => {
    const token = randomToken()
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(token).toHaveLength(43)
  })

  it('honours the byteLength parameter and does not repeat', () => {
    expect(randomToken(24)).toHaveLength(32)
    expect(randomToken()).not.toBe(randomToken())
  })
})
