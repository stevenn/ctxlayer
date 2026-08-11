import { describe, expect, it } from 'vitest'
import { scrubCredentialShapes, scrubErrorContent } from './result-postprocess'

/**
 * The §1a credential scrub is deliberately narrow — these tests pin both
 * directions: the shapes it MUST catch, and the diagnostic prose it must
 * NOT touch (the review rejected an aggressive scrub because it blunts
 * genuinely useful upstream error text).
 */
describe('scrubCredentialShapes', () => {
  it.each([
    ['authorization header echo', 'got 401 with Authorization: Bearer ghp_abc123DEF456ghi789JKL sent'],
    ['authorization basic echo', 'request had authorization: Basic dXNlcjpwYXNzd29yZA=='],
    ['bare bearer blob', 'retried with bearer eyXt0ken0verTwentyChars11 and failed'],
    ['jwt triplet', 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c rejected'],
    ['github pat', 'using ghp_16C7e42F292c6912E7710c838347Ae178B4a'],
    ['github fine-grained pat', 'header was github_pat_11ABCDEFG0123456789_abcdefghij0123456789'],
    ['slack token', 'posted with xoxb-1234567890-abcdefghijk'],
    ['sk- style key', 'client used sk-proj-Abc123Def456Ghi789Jkl012'],
    ['aws access key id', 'signed request as AKIAIOSFODNN7EXAMPLE failed']
  ])('redacts a %s', (_name, input) => {
    const out = scrubCredentialShapes(input)
    expect(out).toContain('[redacted-credential]')
    expect(out).not.toMatch(/ghp_|github_pat_|xox[baprs]-|sk-[A-Za-z0-9_-]{20}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{8}/)
    expect(out).not.toContain('dXNlcjpwYXNzd29yZA')
  })

  it.each([
    ['plain 404 text', 'HTTP 404 Not Found: repository does not exist'],
    ['auth prose without a value', 'authorization failed: token expired, please reconnect'],
    ['bearer as a word', 'the bearer of this message is not authorized'],
    ['short token mention', 'invalid token abc123'],
    ['hostnames and paths survive', 'GET https://api.github.com/repos/acme/x: 403 SAML enforcement'],
    ['task ids are not sk- keys', 'job sk-12 and task-9982 are queued']
  ])('leaves %s untouched', (_name, input) => {
    expect(scrubCredentialShapes(input)).toBe(input)
  })
})

describe('scrubErrorContent', () => {
  it('scrubs text items in an MCP content array, preserving other items', () => {
    const out = scrubErrorContent([
      { type: 'text', text: 'failed: Authorization: Bearer abc.def sent upstream' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' }
    ]) as Array<Record<string, unknown>>
    expect(out[0]?.text).toContain('[redacted-credential]')
    expect(out[0]?.text).not.toContain('abc.def')
    expect(out[1]).toEqual({ type: 'image', data: 'AAAA', mimeType: 'image/png' })
  })

  it('scrubs a bare-string content payload', () => {
    expect(scrubErrorContent('401 Authorization: Bearer tok123')).toBe(
      '401 [redacted-credential]'
    )
  })

  it('passes unrecognised shapes through unchanged', () => {
    const weird = { code: 500, message: 'x' }
    expect(scrubErrorContent(weird)).toBe(weird)
  })
})
