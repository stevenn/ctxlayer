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
