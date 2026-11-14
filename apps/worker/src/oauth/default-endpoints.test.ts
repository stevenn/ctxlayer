import { describe, expect, it } from 'vitest'
import { aliasDefaultOAuthEndpoint } from './default-endpoints'
import { isCimdClientId } from './cimd'

describe('aliasDefaultOAuthEndpoint', () => {
  it.each([
    ['/token', '/oauth/token'],
    ['/register', '/oauth/register']
  ])('re-addresses %s to %s in place', (from, to) => {
    const out = aliasDefaultOAuthEndpoint(new Request(`https://mcp.example${from}?a=1&b=2`))
    expect(out).toBeInstanceOf(Request)
    const url = new URL((out as Request).url)
    expect(url.pathname).toBe(to)
    expect(url.search).toBe('?a=1&b=2')
    expect(url.host).toBe('mcp.example')
  })

  it('redirects /authorize to /oauth/authorize, query intact', () => {
    // A redirect, not an in-place rewrite: an edge gate on /oauth/authorize
    // (Cloudflare Access) must still see the browser.
    const out = aliasDefaultOAuthEndpoint(
      new Request('https://mcp.example/authorize?client_id=c&state=s%20t')
    )
    expect(out).toBeInstanceOf(Response)
    const res = out as Response
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(
      'https://mcp.example/oauth/authorize?client_id=c&state=s%20t'
    )
  })

  it('keeps method, headers and body of a token POST', async () => {
    const out = aliasDefaultOAuthEndpoint(
      new Request('https://mcp.example/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=refresh_token&refresh_token=abc'
      })
    ) as Request
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
