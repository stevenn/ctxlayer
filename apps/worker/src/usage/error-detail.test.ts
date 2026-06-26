import { describe, it, expect } from 'vitest'
import {
  classifyUpstreamError,
  errorTextFromContent,
  scrubErrorForStorage
} from './error-detail'

describe('classifyUpstreamError', () => {
  it('maps the timeout status straight through, regardless of text', () => {
    expect(classifyUpstreamError('timeout', 'anything at all')).toBe('timeout')
  })

  it('classifies auth failures before the generic 4xx', () => {
    expect(classifyUpstreamError('error', 'HTTP 401 Unauthorized')).toBe('upstream_auth')
    expect(classifyUpstreamError('error', '403 Forbidden')).toBe('upstream_auth')
    expect(classifyUpstreamError('error', 'invalid_grant: token expired')).toBe('upstream_auth')
  })

  it('classifies 5xx and 4xx HTTP families', () => {
    expect(classifyUpstreamError('error', 'Internal Server Error (500)')).toBe('upstream_5xx')
    expect(classifyUpstreamError('error', '502 Bad Gateway')).toBe('upstream_5xx')
    expect(classifyUpstreamError('error', 'HTTP 404 Not Found')).toBe('upstream_4xx')
    expect(classifyUpstreamError('error', '429 too many requests')).toBe('upstream_4xx')
  })

  it('classifies network / unreachable failures', () => {
    expect(classifyUpstreamError('error', 'connect ECONNREFUSED 10.0.0.1:443')).toBe(
      'upstream_unreachable'
    )
    expect(classifyUpstreamError('error', 'getaddrinfo ENOTFOUND api.example.com')).toBe(
      'upstream_unreachable'
    )
    expect(classifyUpstreamError('error', 'fetch failed')).toBe('upstream_unreachable')
  })

  it('falls back to the generic upstream_error', () => {
    expect(classifyUpstreamError('error', 'something weird happened')).toBe('upstream_error')
  })
})

describe('scrubErrorForStorage', () => {
  it('redacts credentials', () => {
    expect(scrubErrorForStorage('Authorization: Bearer sk-abcdef0123456789')).not.toMatch(
      /sk-abcdef/
    )
    expect(scrubErrorForStorage('Bearer abcdef0123456789ghijkl')).toBe('Bearer [redacted]')
    expect(scrubErrorForStorage('api_key=ABCDEFGH12345678')).toContain('[redacted]')
  })

  it('KEEPS host / IP / URL — the operator-useful bits', () => {
    const out = scrubErrorForStorage('connect ECONNREFUSED 10.0.0.5:443 to https://api.acme.dev/v1')
    expect(out).toContain('10.0.0.5')
    expect(out).toContain('https://api.acme.dev/v1')
  })

  it('strips Node stack frames and control chars, and caps length', () => {
    const withStack = 'Boom\n    at foo (/srv/app.js:1:2)\n    at bar (/srv/app.js:3:4)'
    const out = scrubErrorForStorage(withStack)
    expect(out).toBe('Boom')
    expect(scrubErrorForStorage('a'.repeat(500)).length).toBe(200)
  })
})

describe('errorTextFromContent', () => {
  it('joins text parts out of an MCP content array', () => {
    expect(
      errorTextFromContent([
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' }
      ])
    ).toBe('first second')
  })

  it('falls back to JSON for non-text content, and passes strings through', () => {
    expect(errorTextFromContent('plain string')).toBe('plain string')
    expect(errorTextFromContent({ code: 7 })).toBe('{"code":7}')
  })
})
