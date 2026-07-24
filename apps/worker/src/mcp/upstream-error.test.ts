import { describe, expect, it } from 'vitest'
import { CTX_MARK_CLOSE, CTX_MARK_OPEN } from './provenance'
import { formatUpstreamError, samlSsoNudge, sanitiseUpstreamError } from './upstream-error'

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
    expect(sanitiseUpstreamError('fetch failed: api_key=sk-live-abcdef0123456789')).toMatch(
      /\[redacted\]/
    )
    expect(sanitiseUpstreamError('rejected token=ghp_0123456789abcdefghijklmn')).toMatch(
      /\[redacted\]/
    )
  })

  it('strips URLs', () => {
    const out = sanitiseUpstreamError(
      'fetch to https://internal.example.com/v1/resource?key=secret failed'
    )
    expect(out).not.toMatch(/example\.com/)
    expect(out).toMatch(/\[url\]/)
  })

  it('strips IPv4 + IPv6 addresses', () => {
    expect(sanitiseUpstreamError('connect to 192.168.1.42:5432 refused')).toMatch(/\[ip\]/)
    expect(sanitiseUpstreamError('connect to 2001:db8::1 refused')).toMatch(/\[ip\]/)
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
    expect(sanitiseUpstreamError('HTTP 504 Gateway Timeout')).toBe('HTTP 504 Gateway Timeout')
    expect(sanitiseUpstreamError('HTTP 429 rate limited')).toBe('HTTP 429 rate limited')
  })

  it('strips control chars (no ANSI / smuggled escapes)', () => {
    const out = sanitiseUpstreamError('upstream said: \x1b[31merror\x1b[0m')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting the ESC byte is stripped
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

describe('samlSsoNudge', () => {
  const SAML =
    'failed to resolve git reference: failed to get repository info: GET ' +
    'https://api.github.com/repos/The-Yuki-Company/yuki-public-api-specs: 403 ' +
    'Resource protected by organization SAML enforcement. You must grant your OAuth ' +
    'token access to this organization.'

  it('returns a first-party playbook for a SAML-SSO refusal, marked as ctxlayer-authored', () => {
    const out = samlSsoNudge(SAML, 'up-github')
    expect(out).not.toBeNull()
    expect(out).toContain(CTX_MARK_OPEN)
    expect(out).toContain(CTX_MARK_CLOSE)
    expect(out).toContain('SAML')
  })

  it('extracts the org and builds the SSO URL from it', () => {
    const out = samlSsoNudge(SAML, 'up-github')!
    expect(out).toContain('"The-Yuki-Company"')
    expect(out).toContain('https://github.com/orgs/The-Yuki-Company/sso')
  })

  it('names the connector slug + the exact reconnect route', () => {
    const out = samlSsoNudge(SAML, 'up-github')!
    expect(out).toContain('up-github')
    expect(out).toContain('/app/upstreams')
    expect(out).toContain('Reconnect')
  })

  it('does not echo the raw upstream text verbatim (no leaked repo path)', () => {
    const out = samlSsoNudge(SAML, 'up-github')!
    expect(out).not.toContain('yuki-public-api-specs')
    expect(out).not.toContain('api.github.com/repos')
  })

  it('falls back to a placeholder org when none is parsable', () => {
    const out = samlSsoNudge('403 Resource protected by organization SAML enforcement.', 'up-github')!
    expect(out).toContain('https://github.com/orgs/<your-org>/sso')
  })

  it('returns null for an unrelated error (no false rewrite)', () => {
    expect(samlSsoNudge('HTTP 404 Not Found', 'up-github')).toBeNull()
    expect(samlSsoNudge('', 'up-github')).toBeNull()
  })
})
