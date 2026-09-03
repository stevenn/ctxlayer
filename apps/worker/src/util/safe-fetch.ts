/**
 * Runtime trust-boundary re-check for admin-configured outbound URLs.
 *
 * The Zod schemas enforce https at the trust boundary (admin REST); this
 * re-asserts it at the dial site (defense in depth — the runtime's
 * `global_fetch_strictly_public` flag already blocks RFC1918 egress, but
 * not a downgrade to cleartext http on a public host). Loopback http is
 * allowed to keep the local-dev story.
 */

import { isHttpsOrLoopback } from '@ctxlayer/shared'

/** Throw unless the URL is https (or a dev loopback http URL). */
export function assertSafeFetchUrl(url: string, context = 'fetch'): void {
  if (!isHttpsOrLoopback(url)) {
    throw new Error(`${context}: refusing to fetch a non-https url`)
  }
}

const MAX_REDIRECTS = 5
const REDIRECT_STATUSES = [301, 302, 303, 307, 308]

/**
 * Header names that are credentials no matter who dialled. Not the whole
 * story: an upstream can be configured to carry its secret under any name at
 * all (`authConfig.http.headerName`, e.g. `X-Notion-Auth`), and such a header
 * is invisible to a fixed list like this one. Callers that mint their own
 * credential headers MUST name them in `credentialHeaders`.
 */
const ALWAYS_CREDENTIAL_HEADERS = ['authorization', 'proxy-authorization', 'cookie']

/**
 * fetch that follows redirects MANUALLY, re-asserting the https trust check
 * on every hop and dropping credential headers when a hop changes origin.
 * Native `redirect: 'follow'` validates hop 0 only, and whether the runtime
 * strips `Authorization` cross-origin is a detail this repo neither asserts
 * nor tests — so we own the hops ourselves (July-review 1c).
 *
 * `credentialHeaders` names any further headers to drop cross-origin —
 * anything the caller attached to authenticate. Omitting a credential header
 * here hands it to whatever host the upstream redirects to.
 */
export async function fetchWithSafeRedirects(
  url: string,
  init: RequestInit = {},
  context = 'fetch',
  credentialHeaders: readonly string[] = []
): Promise<Response> {
  let current = url
  let headers = new Headers(init.headers)
  let method = init.method ?? 'GET'
  let body = init.body
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    assertSafeFetchUrl(current, context)
    const res = await fetch(current, { ...init, method, body, headers, redirect: 'manual' })
    const location = res.headers.get('location')
    if (!REDIRECT_STATUSES.includes(res.status) || !location) return res
    if (res.body) await res.body.cancel().catch(() => {})
    const next = new URL(location, current)
    if (next.origin !== new URL(current).origin) {
      headers = new Headers(headers)
      // Headers.delete is case-insensitive, so a configured name matches
      // however the caller spelled it.
      for (const name of [...ALWAYS_CREDENTIAL_HEADERS, ...credentialHeaders]) {
        headers.delete(name)
      }
    }
    // 303 always demotes to GET; historically 301/302 do too for non-GET.
    if (
      res.status === 303 ||
      ((res.status === 301 || res.status === 302) && method !== 'GET' && method !== 'HEAD')
    ) {
      method = 'GET'
      body = undefined
    }
    current = next.toString()
  }
  throw new Error(`${context}: too many redirects (>${MAX_REDIRECTS})`)
}

/** Thrown by `readTextCapped` when the body exceeds the byte cap — typed so
 * callers can tell an oversized response from a mid-body network failure. */
export class ResponseTooLargeError extends Error {
  constructor(context: string, readonly maxBytes: number) {
    super(`${context}: response exceeded ${maxBytes} bytes`)
    this.name = 'ResponseTooLargeError'
  }
}

/**
 * Read a response body as text, aborting once it exceeds `maxBytes`
 * (July-review 1d: `await res.text()` buffers unboundedly in worker memory).
 */
export async function readTextCapped(
  res: Response,
  maxBytes: number,
  context = 'fetch'
): Promise<string> {
  const reader = res.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new ResponseTooLargeError(context, maxBytes)
    }
    chunks.push(value)
  }
  const buf = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    buf.set(c, off)
    off += c.byteLength
  }
  return new TextDecoder().decode(buf)
}
