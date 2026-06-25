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
import { accessTrustConfigured, verifyCfAccessJwt } from '../auth/cf-access'
import { upsertUser } from '../db/queries/users'
import { completeMcpAuthorization } from '../idp/complete-mcp'

const AUTH_REQ_TTL_SECONDS = 600

export async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const authReq = await env.OAUTH_PROVIDER.parseAuthRequest(request)
  const requestId = randomToken(24)
  await env.OAUTH_KV.put(`authReq:${requestId}`, JSON.stringify(authReq), {
    expirationTtl: AUTH_REQ_TTL_SECONDS
  })

  // Cloudflare Access bridge. When this path is gated by Access (e.g. the mcp.*
  // custom domain), the edge has already authenticated the user against the org
  // IdP and forwards a signed `Cf-Access-Jwt-Assertion`. Trust it to complete
  // the MCP grant directly — skipping the GitHub/Google chooser, which Entra-only
  // users can't satisfy. Mirrors `establishFromAccess` in auth/middleware.ts (the
  // SPA path); the only difference is the tail completes an OAuth grant instead
  // of minting a session cookie. Falls through to the chooser when there's no /
  // an invalid Access token, so the app stays generic for non-Access deploys.
  if (accessTrustConfigured(env)) {
    const viaAccess = await tryCompleteViaAccess(request, env, requestId)
    if (viaAccess) return viaAccess
  }

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

/**
 * Complete the MCP authorize grant from a Cloudflare Access token, or return
 * null to fall back to the IdP chooser.
 *
 * Returns a Response in two terminal cases: the grant completed (302 to the
 * client, from `completeMcpAuthorization`), or a 403 page for a stored
 * suspended/pending account. Returns null only when there is no usable Access
 * token (header absent or verification failed) so the caller renders the
 * chooser — keeping the handler generic for non-Access deployments.
 *
 * Admission mirrors `establishFromAccess` (auth/middleware.ts): Access has
 * already decided WHO may reach this path, so we skip the local IdP allowlist —
 * but the stored lifecycle status still wins (an in-app suspend blocks) and
 * ADMIN_EMAILS still confers admin via `upsertUser`. `requestId` is the id under
 * which the parsed authorize request was just stashed in OAUTH_KV;
 * `completeMcpAuthorization` consumes it.
 */
async function tryCompleteViaAccess(
  request: Request,
  env: Env,
  requestId: string
): Promise<Response | null> {
  const token = request.headers.get('cf-access-jwt-assertion')
  if (!token) return null
  const identity = await verifyCfAccessJwt(token, env)
  if (!identity) return null

  const { user } = await upsertUser(
    env,
    {
      idp: 'access',
      idpSub: identity.sub,
      email: identity.email,
      name: identity.name,
      avatarUrl: null
    },
    'active'
  )
  if (user.status !== 'active') return renderBlockedPage(user.status)

  return completeMcpAuthorization(env, requestId, user)
}

/**
 * A 403 page for an Access-authenticated user whose in-app account isn't active.
 * Falling through to the chooser would be a dead end (Entra-only users can't use
 * the GitHub/Google legs either), so we state the reason plainly instead.
 */
function renderBlockedPage(status: string): Response {
  const message =
    status === 'pending'
      ? 'Your account is awaiting administrator approval. Try again once it has been approved.'
      : 'Your account has been suspended. Contact an administrator if you believe this is a mistake.'
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Authorize · ctxlayer</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:420px;margin:80px auto;padding:0 24px;color:#0f172a">
<h1 style="font-size:20px">Can't authorize</h1>
<p style="color:#64748b;font-size:14px">${escapeHtml(message)}</p>
</body></html>`
  return new Response(html, {
    status: 403,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
  })
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

  // Inline "layers" mark — same SVG as the SPA sign-in card / favicon, brand
  // orange via `--brand`. Dependency-free so it renders without the bundle.
  const brand = `<div class="brand">
      <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M12 2 2 7l10 5 10-5-10-5Z" />
        <path d="M2 17l10 5 10-5" />
        <path d="M2 12l10 5 10-5" />
      </svg>
      <span>ctxlayer</span>
    </div>`

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Authorize · ctxlayer</title>
<style>
  :root { color-scheme: light dark; --brand: #f38020; }
  *, *::before, *::after { box-sizing: border-box; }
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
  .brand { display: flex; align-items: center; gap: 8px; margin: 0 0 18px; }
  .brand svg { color: var(--brand); flex: none; }
  .brand span { font-size: 22px; font-weight: 700; letter-spacing: -0.01em; }
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
    ${brand}
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
