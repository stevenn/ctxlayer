import { describe, expect, it } from 'vitest'
import { formatUpstreamError, sanitiseUpstreamError } from './upstream-error'

describe('sanitiseUpstreamError', () => {
  it('returns empty for empty input', () => {
    expect(sanitiseUpstreamError('')).toBe('')
  })

  it('redacts Bearer tokens', () => {
    const out = sanitiseUpstreamError(
      'fetch failed: 401 Authorization: Bearer sk-abcdefghij1234567890 expired'
    )
    expect(out).not.toMatch(/sk-abc/)
    expect(out).toMatch(/Authorization: \[redacted\]/)
  })

  it('redacts inline Bearer header in error body', () => {
    const out = sanitiseUpstreamError('upstream said: Bearer eyJhbGciOiJI…')
    expect(out).toMatch(/Bearer \[redacted\]/)
  })

  it('redacts generic key=value secrets', () => {
    expect(
      sanitiseUpstreamError('fetch failed: api_key=sk-live-abcdef0123456789')
    ).toMatch(/\[redacted\]/)
    expect(
      sanitiseUpstreamError('rejected token=ghp_0123456789abcdefghijklmn')
    ).toMatch(/\[redacted\]/)
  })

  it('strips URLs', () => {
    const out = sanitiseUpstreamError(
      'fetch to https://internal.example.com/v1/resource?key=secret failed'
    )
    expect(out).not.toMatch(/example\.com/)
    expect(out).toMatch(/\[url\]/)
  })

  it('strips IPv4 + IPv6 addresses', () => {
    expect(sanitiseUpstreamError('connect to 192.168.1.42:5432 refused')).toMatch(
      /\[ip\]/
    )
    expect(sanitiseUpstreamError('connect to 2001:db8::1 refused')).toMatch(
      /\[ip\]/
    )
  })

  it('strips Node-style stack frames', () => {
    const out = sanitiseUpstreamError(
      'TypeError: foo at Object.<anonymous> (/var/app/worker.js:42:7)'
    )
    expect(out).not.toMatch(/worker\.js/)
    expect(out).not.toMatch(/at /)
    expect(out).toMatch(/TypeError: foo/)
  })

  it('collapses whitespace and caps at 200 chars', () => {
    const long = 'fetch failed: '.repeat(50)
    const out = sanitiseUpstreamError(long)
    expect(out.length).toBeLessThanOrEqual(200)
    expect(out).not.toMatch(/\s{2,}/)
  })

  it('preserves meaningful HTTP-status detail', () => {
    expect(sanitiseUpstreamError('HTTP 504 Gateway Timeout')).toBe(
      'HTTP 504 Gateway Timeout'
    )
    expect(sanitiseUpstreamError('HTTP 429 rate limited')).toBe(
      'HTTP 429 rate limited'
    )
  })

  it('strips control chars (no ANSI / smuggled escapes)', () => {
    const out = sanitiseUpstreamError('upstream said: \x1b[31merror\x1b[0m')
    expect(out).not.toMatch(/\x1b/)
    expect(out).toMatch(/error/)
  })
})

describe('formatUpstreamError', () => {
  it('emits the code + sanitised tail + ref id', () => {
    const { userMessage, refId } = formatUpstreamError({
      slug: 'driver',
      toolName: 'fetch_registered_content',
      status: 'timeout',
      rawMessage: 'request timed out after 60000ms'
    })
    expect(userMessage).toMatch(/^upstream_timeout:/)
    expect(userMessage).toContain('driver.fetch_registered_content')
    expect(userMessage).toContain('60000ms')
    expect(userMessage).toContain(`ref=${refId}`)
    expect(refId).toMatch(/^[0-9a-f]{8}$/)
  })

  it('uses an externally-supplied refId when given (for log correlation)', () => {
    const out = formatUpstreamError({
      slug: 'notion',
      toolName: 'notion-search',
      status: 'error',
      rawMessage: 'HTTP 500',
      refId: 'deadbeef'
    })
    expect(out.refId).toBe('deadbeef')
    expect(out.userMessage).toContain('ref=deadbeef')
  })

  it('drops the dangling — when sanitised message is empty', () => {
    const out = formatUpstreamError({
      slug: 'x',
      toolName: 'y',
      status: 'error',
      rawMessage: ''
    })
    expect(out.userMessage).not.toContain(' — ')
    expect(out.userMessage).toMatch(/upstream_error: x\.y \(ref=/)
  })
})
