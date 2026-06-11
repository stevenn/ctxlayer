/**
 * Revoke every OAuth grant a user holds — all their MCP + CLI bearer/refresh
 * tokens at once. Used on suspend/delete for *instant* MCP cutoff.
 *
 * The provider's token format is `{userId}:{grantId}:{secret}`, so revoking a
 * grant invalidates every token minted under it: the next authenticated MCP
 * request (a tool-call POST, an SSE message, or a token refresh) 401s and the
 * agent's session ends. This complements the two existing gates:
 *   - per-request SPA status re-check (auth/middleware.ts) — cuts the cookie,
 *   - McpSessionDO.init() lifecycle gate — blocks a fresh reconnect,
 * closing the one remaining window: an already-open MCP session whose bearer
 * was still valid.
 *
 * Best-effort: a partial/total KV failure is swallowed (logged) and reported
 * via `complete:false`, because the status change is the authoritative lockout
 * and the two gates above still hold. Returns the number of grants revoked.
 */

import { getOAuthApi } from '@cloudflare/workers-oauth-provider'
import type { Env } from '../env'
import { oauthProviderOptions } from './provider-config'

export async function revokeAllUserGrants(
  env: Env,
  userId: string
): Promise<{ revoked: number; complete: boolean }> {
  const helpers = getOAuthApi<Env>(oauthProviderOptions(), env)
  let revoked = 0
  let complete = true
  try {
    let cursor: string | undefined
    do {
      const page = await helpers.listUserGrants(userId, { limit: 100, cursor })
      for (const g of page.items) {
        try {
          await helpers.revokeGrant(g.id, userId)
          revoked++
        } catch (err) {
          complete = false
          console.warn(
            `[revoke-grants] revokeGrant(${g.id}) failed:`,
            err instanceof Error ? err.message : String(err)
          )
        }
      }
      cursor = page.cursor ?? undefined
    } while (cursor)
  } catch (err) {
    complete = false
    console.warn(
      `[revoke-grants] listUserGrants(${userId}) failed:`,
      err instanceof Error ? err.message : String(err)
    )
  }
  return { revoked, complete }
}
