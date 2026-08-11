/**
 * SSR'd /oauth/authorize handler — the consent interstitial for
 * MCP-client-initiated OAuth (July review §1e).
 *
 * DCR is open, so any party can register a client and send a user here
 * with one link; the page is what stands between that link and a grant.
 * It names the client, where the user will be sent back to, and what the
 * grant allows, and requires an explicit approval act:
 *
 *  - IdP deploys: the "Approve & continue with GitHub/Google" links ARE
 *    the approval — the flow finishes via the same IdP legs as a SPA
 *    sign-in. A Deny button bounces back to the client with
 *    `error=access_denied` (RFC 6749 §4.1.2.1).
 *  - Access-fronted deploys: the edge already authenticated the user, so
 *    the page shows plain Approve/Deny; Approve re-verifies the Access
 *    JWT on the POST. Setting OAUTH_CONSENT_SKIP_VIA_ACCESS restores the
 *    zero-click completion for deploys that treat Access itself as the
 *    consent boundary.
 *
 * The parsed OAuth authorize request is stashed in OAUTH_KV under a
 * short-lived `authReq:<id>` key; both the IdP `start` URLs and the
 * decision form carry the id so the completion leg can resume + call
 * `provider.completeAuthorization`.
 *
 * The page is intentionally dependency-free HTML — no SPA boot — so it
 * renders instantly and works even if the client blocks the Workers
 * Assets bundle.
 */

import type { Env } from '../env'
import { randomToken } from '../util/base64url'
import { accessTrustConfigured, verifyCfAccessJwt } from '../auth/cf-access'
import { EmailOnOtherIdpError, upsertUser } from '../db/queries/users'
import { completeMcpAuthorization } from '../idp/complete-mcp'

const AUTH_REQ_TTL_SECONDS = 600

export async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  // 0.9+ workers-oauth-provider throws on malformed / unregistered
  // authorize requests (bad client_id, unregistered redirect_uri, invalid
  // response_type). Render locally — never redirect to a URI the provider
  // refused to validate.
  let authReq: Awaited<ReturnType<Env['OAUTH_PROVIDER']['parseAuthRequest']>>
  try {
    authReq = await env.OAUTH_PROVIDER.parseAuthRequest(request)
  } catch (err) {
    console.warn(`[authorize] parseAuthRequest rejected: ${String(err)}`)
    return renderInvalidRequestPage()
  }
  const requestId = randomToken(24)
  await env.OAUTH_KV.put(`authReq:${requestId}`, JSON.stringify(authReq), {
    expirationTtl: AUTH_REQ_TTL_SECONDS
  })

  const consent: ConsentPageOpts = {
    requestId,
    clientName: await tryClientName(env, authReq.clientId),
    redirectHost: hostOf((authReq as { redirectUri?: unknown }).redirectUri),
    mode: 'idp',
    idps: enabledIdps(env)
  }

  // Cloudflare Access bridge. When this path is gated by Access (e.g. the mcp.*
  // custom domain), the edge has already authenticated the user against the org
  // IdP and forwards a signed `Cf-Access-Jwt-Assertion` — Entra-only users
  // can't satisfy the GitHub/Google legs, so the consent act is a plain
  // Approve/Deny instead of an IdP chooser. With OAUTH_CONSENT_SKIP_VIA_ACCESS
  // set, the grant completes with zero interaction (the pre-§1e behaviour, for
  // deploys that treat the Access gate itself as consent). Falls through to
  // the IdP chooser when there's no / an invalid Access token, so the app
  // stays generic for non-Access deploys.
  if (accessTrustConfigured(env)) {
    const identity = await verifyAccessIdentity(request, env)
    if (identity) {
      if (consentSkipViaAccess(env)) {
        return completeViaAccessIdentity(identity, env, requestId)
      }
      return renderConsentPage({ ...consent, mode: 'access' })
    }
  }

  return renderConsentPage(consent)
}

/**
 * POST /oauth/authorize/decision — the consent form target.
 *
 * `deny` consumes the stashed request and bounces to the client's
 * (provider-validated) redirect_uri with `error=access_denied`. `approve`
 * only exists on Access-fronted deploys — the POST carries the
 * edge-asserted identity, which is re-verified before completing; on IdP
 * deploys the approval act is the IdP start link, so a bare approve POST
 * is invalid. Unauthenticated by design (there is no session yet): the
 * unguessable single-use request_id plus the Sec-Fetch-Site gate bound
 * what a cross-site attacker can do.
 */
export async function handleAuthorizeDecision(request: Request, env: Env): Promise<Response> {
  // Same stance as the 1b fix on /oauth/start: reject what the browser
  // itself labels cross-site; absent header (curl, old browsers) passes.
  const fetchSite = request.headers.get('sec-fetch-site')
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    return new Response('cross_site_navigation', { status: 403 })
  }

  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return renderInvalidRequestPage()
  }
  const requestId = String(form.get('request_id') ?? '')
  const choice = String(form.get('choice') ?? '')
  if (!requestId || (choice !== 'approve' && choice !== 'deny')) {
    return renderInvalidRequestPage()
  }

  if (choice === 'deny') {
    const authReq = await consumeAuthRequest(env, requestId)
    return denyRedirect(authReq)
  }

  if (!accessTrustConfigured(env)) return renderInvalidRequestPage()
  const identity = await verifyAccessIdentity(request, env)
  if (!identity) {
    return new Response('access_identity_required', { status: 403 })
  }
  return completeViaAccessIdentity(identity, env, requestId)
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
 * RFC 6749 §4.1.2.1 denial: bounce to the client's redirect_uri with
 * `error=access_denied` (+ the client's state). The URI came out of
 * `parseAuthRequest`, which validates it against the registered client,
 * so redirecting to it is safe. An expired / double-consumed request
 * renders the local error page instead.
 */
function denyRedirect(authReq: unknown): Response {
  const r = authReq as { redirectUri?: unknown; state?: unknown } | null
  const uri = typeof r?.redirectUri === 'string' ? r.redirectUri : null
  if (!uri) return renderInvalidRequestPage()
  let url: URL
  try {
    url = new URL(uri)
  } catch {
    return renderInvalidRequestPage()
  }
  url.searchParams.set('error', 'access_denied')
  if (typeof r?.state === 'string' && r.state) url.searchParams.set('state', r.state)
  return new Response(null, { status: 302, headers: { Location: url.toString() } })
}

function consentSkipViaAccess(env: Env): boolean {
  const v = (env.OAUTH_CONSENT_SKIP_VIA_ACCESS ?? '').trim().toLowerCase()
  return v === '1' || v === 'true'
}

async function verifyAccessIdentity(
  request: Request,
  env: Env
): Promise<NonNullable<Awaited<ReturnType<typeof verifyCfAccessJwt>>> | null> {
  const token = request.headers.get('cf-access-jwt-assertion')
  if (!token) return null
  return verifyCfAccessJwt(token, env)
}

/**
 * Complete the MCP authorize grant for an Access-verified identity.
 *
 * Returns a Response in two terminal cases: the grant completed (302 to the
 * client, from `completeMcpAuthorization`), or a 403 page for a stored
 * suspended/pending account.
 *
 * Admission mirrors `establishFromAccess` (auth/middleware.ts): Access has
 * already decided WHO may reach this path, so we skip the local IdP allowlist —
 * but the stored lifecycle status still wins (an in-app suspend blocks) and
 * ADMIN_EMAILS still confers admin via `upsertUser`. `requestId` is the id under
 * which the parsed authorize request was stashed in OAUTH_KV;
 * `completeMcpAuthorization` consumes it.
 */
async function completeViaAccessIdentity(
  identity: { sub: string; email: string; name: string | null },
  env: Env,
  requestId: string
): Promise<Response> {
  let user: Awaited<ReturnType<typeof upsertUser>>['user']
  try {
    ;({ user } = await upsertUser(
      env,
      {
        idp: 'access',
        idpSub: identity.sub,
        email: identity.email,
        name: identity.name,
        avatarUrl: null
      },
      'active'
    ))
  } catch (err) {
    if (err instanceof EmailOnOtherIdpError) {
      console.warn('[access] email belongs to a user on another idp; refusing MCP grant')
      return renderBlockedPage('email_other_idp')
    }
    throw err
  }
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
      : status === 'email_other_idp'
        ? 'This email is already registered under a different sign-in provider. Ask an administrator to migrate the account.'
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

/** Local 400 for requests the provider refused to parse or a mangled form. */
function renderInvalidRequestPage(): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Authorize · ctxlayer</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:420px;margin:80px auto;padding:0 24px;color:#0f172a">
<h1 style="font-size:20px">Invalid authorization request</h1>
<p style="color:#64748b;font-size:14px">The request was malformed, expired, or came from an
unregistered client. Start again from your MCP client; if it keeps failing, contact an
administrator.</p>
</body></html>`
  return new Response(html, {
    status: 400,
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

function hostOf(uri: unknown): string | null {
  if (typeof uri !== 'string') return null
  try {
    return new URL(uri).host
  } catch {
    return null
  }
}

interface ConsentPageOpts {
  requestId: string
  clientName: string | null
  redirectHost: string | null
  /** 'access': plain Approve/Deny (edge-verified identity). 'idp': the IdP links approve. */
  mode: 'access' | 'idp'
  idps: Array<'google' | 'github'>
}

function renderConsentPage(opts: ConsentPageOpts): Response {
  return new Response(renderPage(opts), {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
  })
}

function renderPage(opts: ConsentPageOpts): string {
  const { requestId, clientName, redirectHost, mode, idps } = opts
  const subtitle = clientName
    ? `<strong>${escapeHtml(clientName)}</strong> wants to access ctxlayer.`
    : 'An MCP client wants to access ctxlayer.'

  // What approval grants — the §1e complaint was that signing in silently
  // WAS the grant; this names it.
  const grantBox = `<ul class="grant">
      <li>Read the docs, skills and search results your account can see</li>
      <li>Call the upstream tools you've been granted, acting as you</li>
    </ul>`
  const returnNote = redirectHost
    ? `<p class="muted">Afterwards you'll be sent back to <strong>${escapeHtml(redirectHost)}</strong>.</p>`
    : ''

  const denyButton = `<button class="btn" type="submit" name="choice" value="deny">Deny</button>`
  const actions =
    mode === 'access'
      ? `<form method="post" action="/oauth/authorize/decision">
      <input type="hidden" name="request_id" value="${escapeHtml(requestId)}" />
      <button class="btn primary" type="submit" name="choice" value="approve">Approve</button>
      ${denyButton}
    </form>`
      : `${
          idps.length === 0
            ? `<div class="empty">No identity providers configured on this deployment. Ask an admin to set ALLOWED_GOOGLE_HD or ALLOWED_GITHUB_ORG.</div>`
            : idps
                .map(
                  (idp) =>
                    `<a class="btn primary" href="/idp/${idp}/start?oauth_request_id=${encodeURIComponent(
                      requestId
                    )}">Approve &amp; continue with ${idp === 'google' ? 'Google' : 'GitHub'}</a>`
                )
                .join('')
        }
    <form method="post" action="/oauth/authorize/decision">
      <input type="hidden" name="request_id" value="${escapeHtml(requestId)}" />
      ${denyButton}
    </form>`

  const footnote =
    mode === 'access'
      ? 'Approving returns you to the MCP client with access granted.'
      : "You'll sign in with your organisation account, then return to the MCP client."

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
    .grant { border-color: #353b50; color: #cbd5e1; }
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
  .muted { color: #64748b; font-size: 13px; margin: 0 0 12px; }
  .grant {
    margin: 0 0 16px; padding: 10px 12px 10px 28px;
    border: 1px solid #cbd5e1; border-radius: 4px;
    font-size: 13px; color: #334155;
  }
  .grant li { margin: 4px 0; }
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
    ${grantBox}
    ${returnNote}
    ${actions}
    <p class="footnote">${footnote}</p>
  </div>
</body>
</html>`
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
  )
}
