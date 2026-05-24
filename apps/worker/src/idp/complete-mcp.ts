/**
 * Bridge between the IdP callback and `workers-oauth-provider`.
 *
 * When an MCP client kicks off OAuth, the user lands on the IdP via
 * /idp/{idp}/start?oauth_request_id=<id>. After the IdP callback
 * verifies + upserts the user, this helper consumes the original
 * authorize request from KV and calls `provider.completeAuthorization`
 * — that returns the redirect URL with the OAuth code that the MCP
 * client trades for an access token at /oauth/token.
 *
 * `props` is the small set of claims we want attached to every
 * authenticated MCP request (userId, email, role). The provider
 * encrypts and stores it on the token; McpAgent reads it via
 * `ctx.props` per request.
 */

import { clearStateCookie } from './common'
import { consumeAuthRequest } from '../oauth/authorize-page'
import type { Env, McpProps } from '../env'
import type { UserRow } from '../db/queries/users'

export async function completeMcpAuthorization(
  env: Env,
  oauthRequestId: string,
  user: UserRow
): Promise<Response> {
  const authReq = await consumeAuthRequest(env, oauthRequestId)
  if (!authReq) {
    // The KV entry expired or was double-consumed. Bounce back to
    // sign-in with a friendly error — the MCP client will see the
    // failure surfaced as a missing token and prompt re-authorize.
    const url = new URL('/sign-in', env.PUBLIC_BASE_URL)
    url.searchParams.set('error', 'state_mismatch')
    return Response.redirect(url.toString(), 302)
  }

  const props: McpProps = {
    userId: user.id,
    email: user.email,
    role: user.role
  }

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    // The library accepts the parsed AuthRequest object from
    // parseAuthRequest() (cast to its expected type).
    request: authReq as Parameters<
      Env['OAUTH_PROVIDER']['completeAuthorization']
    >[0]['request'],
    userId: user.id,
    metadata: { idp: user.idp, email: user.email },
    scope: ['mcp'],
    props
  })

  const headers = new Headers()
  headers.set('Location', redirectTo)
  headers.append('Set-Cookie', clearStateCookie())
  return new Response(null, { status: 302, headers })
}
