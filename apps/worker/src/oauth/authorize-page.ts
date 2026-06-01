/**
 * SSR'd /oauth/authorize handler. Renders a minimal IdP chooser that
 * lets an MCP-client-initiated OAuth flow finish via the same IdP
 * legs as a SPA sign-in. The parsed OAuth authorize request is
 * stashed in OAUTH_KV under a short-lived `authReq:<id>` key; the
 * IdP `start` URLs receive `?oauth_request_id=<id>` so the callback
 * can resume + call `provider.completeAuthorization`.
 *
 * The page is intentionally dependency-free HTML — no SPA boot — so
 * the IdP chooser renders instantly and works even if the client
 * blocks the Workers Assets bundle.
 */

import type { Env } from '../env'
import { randomToken } from '../idp/common'

const AUTH_REQ_TTL_SECONDS = 600

export async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const authReq = await env.OAUTH_PROVIDER.parseAuthRequest(request)
  const requestId = randomToken(24)
  await env.OAUTH_KV.put(`authReq:${requestId}`, JSON.stringify(authReq), {
    expirationTtl: AUTH_REQ_TTL_SECONDS
  })
  const idps = enabledIdps(env)
  const clientName = await tryClientName(env, authReq.clientId)
  return new Response(renderPage(requestId, idps, clientName), {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
  })
}

/** Look up the authorize request that was stashed for this requestId. */
export async function consumeAuthRequest(env: Env, requestId: string): Promise<unknown | null> {
  const raw = await env.OAUTH_KV.get(`authReq:${requestId}`)
  if (!raw) return null
  // Delete after the lookup so the request is single-use; ignore errors
  // (KV will TTL it anyway).
  env.OAUTH_KV.delete(`authReq:${requestId}`).catch(() => {})
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function enabledIdps(env: Env): Array<'google' | 'github'> {
  const out: Array<'google' | 'github'> = []
  if (env.ALLOWED_GOOGLE_HD?.length || env.ALLOWED_GOOGLE_EMAILS?.length) out.push('google')
  if (env.ALLOWED_GITHUB_ORG?.length || env.ALLOWED_GITHUB_USERS?.length) out.push('github')
  return out
}

async function tryClientName(env: Env, clientId: string): Promise<string | null> {
  try {
    const c = await env.OAUTH_PROVIDER.lookupClient(clientId)
    return c?.clientName ?? null
  } catch {
    return null
  }
}

function renderPage(
  requestId: string,
  idps: Array<'google' | 'github'>,
  clientName: string | null
): string {
  const buttons = idps
    .map(
      (idp) =>
        `<a class="btn" href="/idp/${idp}/start?oauth_request_id=${encodeURIComponent(
          requestId
        )}">${idp === 'google' ? 'Sign in with Google' : 'Sign in with GitHub'}</a>`
    )
    .join('')
  const subtitle = clientName
    ? `<strong>${escapeHtml(clientName)}</strong> wants to access ctxlayer.`
    : 'An MCP client wants to access ctxlayer.'

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Authorize · ctxlayer</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    background: #f1f5f9; color: #0f172a;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #0f1117; color: #f8fafc; }
    .card { background: #1a1d27; border-color: #353b50; }
    .btn { background: #242836; border-color: #353b50; color: #f8fafc; }
    .btn:hover { background: #2d3142; }
    .btn.primary { background: #3b82f6; border-color: #3b82f6; color: #fff; }
    .btn.primary:hover { background: #60a5fa; }
    .muted { color: #94a3b8; }
  }
  .card {
    width: 100%; max-width: 380px; margin: 24px;
    background: #ffffff; border: 1px solid #cbd5e1; border-radius: 6px;
    padding: 28px;
  }
  h1 { margin: 0 0 4px; font-size: 20px; font-weight: 700; letter-spacing: -0.01em; }
  .muted { color: #64748b; font-size: 13px; margin: 0 0 20px; }
  .btn {
    display: block; width: 100%; padding: 10px 12px; margin-top: 8px;
    text-align: center; text-decoration: none;
    background: #f8fafc; color: #0f172a;
    border: 1px solid #cbd5e1; border-radius: 4px;
    font: inherit; font-size: 14px; cursor: pointer;
  }
  .btn:hover { background: #e2e8f0; }
  .btn.primary { background: #2563eb; border-color: #2563eb; color: #fff; }
  .btn.primary:hover { background: #1d4ed8; }
  .footnote { margin-top: 20px; font-size: 12px; color: #64748b; }
  .empty { padding: 12px; border: 1px dashed #cbd5e1; border-radius: 4px; font-size: 13px; }
</style>
</head>
<body>
  <div class="card">
    <h1>Authorize</h1>
    <p class="muted">${subtitle}</p>
    ${
      idps.length === 0
        ? `<div class="empty">No identity providers configured on this deployment. Ask an admin to set ALLOWED_GOOGLE_HD or ALLOWED_GITHUB_ORG.</div>`
        : buttons
    }
    <p class="footnote">You'll be returned to the MCP client after signing in.</p>
  </div>
</body>
</html>`
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
  )
}
