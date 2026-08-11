import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchWithSafeRedirects, readTextCapped, ResponseTooLargeError } from './safe-fetch'

/**
 * The manual-redirect discipline (July-review 1c): every hop re-asserts the
 * https trust check, and credential headers are stripped the moment a hop
 * leaves the original origin. Native `redirect: 'follow'` gives neither.
 */

type Call = { url: string; headers: Headers }

function redirectTo(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } })
}

/** Stub fetch with a scripted hop sequence; records each call's URL+headers. */
function scriptFetch(script: Array<Response | ((url: string) => Response)>): Call[] {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: url.toString(), headers: new Headers(init?.headers) })
      const step = script.shift()
      if (!step) throw new Error('script exhausted')
      return typeof step === 'function' ? step(url.toString()) : step
    })
  )
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchWithSafeRedirects', () => {
  it('follows a same-origin redirect and keeps the Authorization header', async () => {
    const calls = scriptFetch([
      redirectTo('https://api.example.com/moved'),
      new Response('ok', { status: 200 })
    ])
    const res = await fetchWithSafeRedirects('https://api.example.com/start', {
      headers: { authorization: 'Bearer sk-secret' }
    })
    expect(res.status).toBe(200)
    expect(calls[1]?.url).toBe('https://api.example.com/moved')
    expect(calls[1]?.headers.get('authorization')).toBe('Bearer sk-secret')
  })

  it('strips credential headers on a cross-origin hop', async () => {
    const calls = scriptFetch([
      redirectTo('https://evil.example.net/collect'),
      new Response('ok', { status: 200 })
    ])
    await fetchWithSafeRedirects('https://api.example.com/start', {
      headers: { authorization: 'Bearer sk-secret', cookie: 'a=b', 'x-custom': 'kept' }
    })
    expect(calls[1]?.url).toBe('https://evil.example.net/collect')
    expect(calls[1]?.headers.get('authorization')).toBeNull()
    expect(calls[1]?.headers.get('cookie')).toBeNull()
    expect(calls[1]?.headers.get('x-custom')).toBe('kept')
  })

  it('re-asserts the https check on every hop, not just hop 0', async () => {
    scriptFetch([redirectTo('http://internal-host.example.com/steal')])
    await expect(
      fetchWithSafeRedirects('https://api.example.com/start', {}, 'git')
    ).rejects.toThrow(/non-https/)
  })

  it('gives up after too many redirects', async () => {
    scriptFetch(
      Array.from({ length: 10 }, (_, i) => redirectTo(`https://api.example.com/hop${i}`))
    )
    await expect(fetchWithSafeRedirects('https://api.example.com/start')).rejects.toThrow(
      /too many redirects/
    )
  })

  it('demotes a redirected POST to GET on 303 and drops the body', async () => {
    const fetchMock = scriptFetch([
      redirectTo('https://api.example.com/see-other', 303),
      new Response('ok', { status: 200 })
    ])
    void fetchMock
    const spy = globalThis.fetch as ReturnType<typeof vi.fn>
    await fetchWithSafeRedirects('https://api.example.com/start', {
      method: 'POST',
      body: '{"a":1}'
    })
    const second = spy.mock.calls[1]?.[1] as RequestInit
    expect(second.method).toBe('GET')
    expect(second.body).toBeUndefined()
  })
})

describe('readTextCapped', () => {
  it('returns the body when under the cap', async () => {
    const text = await readTextCapped(new Response('hello world'), 1024)
    expect(text).toBe('hello world')
  })

  it('throws ResponseTooLargeError past the cap', async () => {
    const big = new Response('x'.repeat(2048))
    await expect(readTextCapped(big, 1024, 'git')).rejects.toBeInstanceOf(ResponseTooLargeError)
  })
})
