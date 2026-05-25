import { describe, expect, it } from 'vitest'
import { isAllowedOrigin } from './origin'

describe('isAllowedOrigin', () => {
  it('accepts exact match (prod shape)', () => {
    expect(
      isAllowedOrigin('https://ctxlayer.example.com', 'https://ctxlayer.example.com')
    ).toBe(true)
  })

  it('rejects mismatched origin in prod', () => {
    expect(isAllowedOrigin('https://evil.example.com', 'https://ctxlayer.example.com')).toBe(false)
  })

  it('rejects null/missing origin', () => {
    expect(isAllowedOrigin(null, 'https://ctxlayer.example.com')).toBe(false)
    expect(isAllowedOrigin('', 'https://ctxlayer.example.com')).toBe(false)
  })

  it('accepts any localhost origin when PUBLIC_BASE_URL is localhost (dev carve-out)', () => {
    expect(isAllowedOrigin('https://localhost:5173', 'https://localhost:8787')).toBe(true)
    expect(isAllowedOrigin('https://localhost:8787', 'https://localhost:8787')).toBe(true)
    expect(isAllowedOrigin('http://127.0.0.1:5173', 'https://localhost:8787')).toBe(true)
  })

  it('does NOT relax when PUBLIC_BASE_URL is a real host (prod)', () => {
    expect(isAllowedOrigin('https://localhost:5173', 'https://ctxlayer.example.com')).toBe(false)
  })

  it('does NOT match non-localhost origins even in dev', () => {
    expect(isAllowedOrigin('https://evil.example.com', 'https://localhost:8787')).toBe(false)
  })
})
