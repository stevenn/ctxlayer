import { describe, expect, it } from 'vitest'
import { aliasDefaultOAuthEndpoint } from './default-endpoints'
import { isCimdClientId } from './cimd'

describe('aliasDefaultOAuthEndpoint', () => {
  it.each([
    ['/token', '/oauth/token'],
    ['/register', '/oauth/register'],
    ['/authorize', '/oauth/authorize']
  ])('re-addresses %s to %s', (from, to) => {
    const out = aliasDefaultOAuthEndpoint(new Request(`https://mcp.example${from}?a=1&b=2`))
    const url = new URL(out.url)
    expect(url.pathname).toBe(to)
    expect(url.search).toBe('?a=1&b=2')
    expect(url.host).toBe('mcp.example')
  })

  it('keeps method, headers and body of a token POST', async () => {
    const out = aliasDefaultOAuthEndpoint(
      new Request('https://mcp.example/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=refresh_token&refresh_token=abc'
      })
    )
    expect(out.method).toBe('POST')
    expect(out.headers.get('content-type')).toBe('application/x-www-form-urlencoded')
    expect(await out.text()).toBe('grant_type=refresh_token&refresh_token=abc')
  })

  it.each(['/oauth/token', '/mcp', '/token/extra', '/api/token', '/'])(
    'leaves %s untouched',
    (path) => {
      const req = new Request(`https://mcp.example${path}`)
      expect(aliasDefaultOAuthEndpoint(req)).toBe(req)
    }
  )
})

describe('isCimdClientId', () => {
  it('recognises an https URL with a path', () => {
    expect(isCimdClientId('https://claude.ai/oauth/mcp-oauth-client-metadata')).toBe(true)
  })

  it.each([
    'atrllyQ8x',
    '',
    'https://claude.ai',
    'https://claude.ai/',
    'http://claude.ai/oauth/client',
    'cursor://anysphere.cursor-mcp/oauth/callback'
  ])('treats %j as a registered (non-CIMD) client id', (id) => {
    expect(isCimdClientId(id)).toBe(false)
  })
})
