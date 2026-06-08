import { describe, expect, it } from 'vitest'
import { withHsts } from './security-headers'

const req = (url: string) => new Request(url)

describe('withHsts', () => {
  it('sets HSTS on a real deployed host', () => {
    const out = withHsts(req('https://dev.ctxlayer.net/api/health'), new Response('ok'))
    expect(out.headers.get('Strict-Transport-Security')).toBe(
      'max-age=31536000; includeSubDomains'
    )
  })

  it('does NOT set HSTS on localhost (would pin the browser to https://localhost:*)', () => {
    for (const u of [
      'https://localhost:8787/',
      'http://127.0.0.1:8787/api/health',
      'https://[::1]:8787/',
      'https://app.localhost/'
    ]) {
      expect(withHsts(req(u), new Response('ok')).headers.get('Strict-Transport-Security')).toBeNull()
    }
  })

  it('passes WebSocket-upgrade responses through untouched', () => {
    // A 101 response can't go through `new Response(...)`; the helper must
    // return the original object so the upgrade still works.
    const original = { status: 101, webSocket: {}, headers: new Headers() } as unknown as Response
    expect(withHsts(req('https://dev.ctxlayer.net/collab/x'), original)).toBe(original)
  })

  it('does not clobber an existing HSTS header', () => {
    const res = new Response('ok', {
      headers: { 'Strict-Transport-Security': 'max-age=1' }
    })
    expect(withHsts(req('https://dev.ctxlayer.net/'), res).headers.get('Strict-Transport-Security')).toBe(
      'max-age=1'
    )
  })

  it('preserves the original status and body', async () => {
    const out = withHsts(req('https://dev.ctxlayer.net/api/x'), new Response('payload', { status: 201 }))
    expect(out.status).toBe(201)
    expect(await out.text()).toBe('payload')
  })
})
