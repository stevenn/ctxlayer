/**
 * Shared tail of the IdP callback flow, used by both github.ts and
 * google.ts. Two invariants live here so they hold on every path:
 *   - token-exchange failures are logged by HTTP status ONLY — the
 *     response body can carry tokens / IdP error metadata and must
 *     never reach the logs;
 *   - sign-in completion clears the IdP state cookie on the SPA branch
 *     (the MCP branch clears it inside completeMcpAuthorization).
 */

import type { Env } from '../env'
import type { UserRow } from '../db/queries/users'
import { signSession, sessionSetCookie } from '../auth/session'
import { csrfSetCookie, newCsrfToken } from '../auth/csrf'
import { completeMcpAuthorization } from './complete-mcp'
import { appRedirect, clearStateCookie, signInErrorRedirect, type StatePayload } from './common'

/**
 * POST the authorization-code exchange and parse the JSON response.
 * Param assembly stays per-IdP (creds, redirect_uri, extra headers);
 * this owns the status-only error logging + error redirect. Returns
 * the untyped JSON body for the caller to narrow.
 */
export async function exchangeCodeForToken(
  env: Env,
  idp: 'google' | 'github',
  tokenUrl: string,
  body: URLSearchParams,
  extraHeaders?: Record<string, string>
): Promise<{ ok: true; json: unknown } | { ok: false; res: Response }> {
  const tokenRes = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...extraHeaders },
    body
  })
  if (!tokenRes.ok) {
    // Never log the body — it can carry access/id/refresh tokens on
    // partial-success shapes, plus full IdP error metadata.
    console.error(`${idp} token exchange failed`, tokenRes.status)
    return { ok: false, res: signInErrorRedirect(env, 'token_exchange_failed') }
  }
  return { ok: true, json: await tokenRes.json() }
}

/**
 * Completion tail after admission succeeded: either finish the MCP
 * OAuth grant (no SPA cookie) or issue session + CSRF cookies and
 * redirect into the app. Both branches clear the IdP state cookie.
 */
export async function finishSignIn(
  env: Env,
  stateRow: StatePayload,
  user: UserRow
): Promise<Response> {
  // MCP OAuth path — complete the grant and redirect to the MCP
  // client's redirect_uri. No SPA cookie is set.
  if (stateRow.oauthRequestId) {
    return completeMcpAuthorization(env, stateRow.oauthRequestId, user)
  }

  // SPA path — issue session + CSRF cookies and redirect back to the app.
  const session = await signSession({ userId: user.id, role: user.role }, env.SESSION_COOKIE_SECRET)
  const res = appRedirect(env, stateRow.returnTo)
  const headers = new Headers(res.headers)
  headers.append('Set-Cookie', sessionSetCookie(session))
  headers.append('Set-Cookie', csrfSetCookie(newCsrfToken()))
  headers.append('Set-Cookie', clearStateCookie())
  return new Response(null, { status: res.status, headers })
}
