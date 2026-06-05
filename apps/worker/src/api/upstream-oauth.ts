/**
 * Outbound OAuth flow for `user_oauth` upstreams (e.g. Notion MCP).
 *
 * - `GET /api/upstreams/:id/oauth/start` — required-user. Builds a per-
 *   request `UpstreamOAuthProvider`, hands it to the SDK's `auth(...)`
 *   orchestrator with `serverUrl = upstream.url`. The SDK runs discovery,
 *   DCR if needed, generates PKCE, and calls
 *   `provider.redirectToAuthorization(url)` — we capture the URL and
 *   return a 302 to it. If `auth()` returns `'AUTHORIZED'` (tokens
 *   already valid) we just redirect back to `/upstreams` — no flow
 *   needed.
 *
 * - `GET /api/upstreams/oauth/callback?code=&state=` — required-user.
 *   Reads `{verifier, userId, upstreamId}` from `OAUTH_KV` using the
 *   `state` query param, verifies the caller matches the original
 *   user (anti-pivot defence), loads the upstream, builds a provider
 *   bound to that state, and calls `auth(provider, {serverUrl,
 *   authorizationCode})`. SDK exchanges the code → tokens → calls
 *   `provider.saveTokens()` which seals them into `user_credentials`.
 *
 * The callback path is GLOBAL (not per-upstream) so we only need one
 * redirect_uri registered per ctxlayer deployment.
 */

import { Hono, type Context } from 'hono'
import { auth as mcpAuth } from '@modelcontextprotocol/sdk/client/auth.js'
import { OAuthError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import type { Env } from '../env'
import { requireUser, type AuthedVariables } from '../auth/middleware'
import {
  deleteUserCredential,
  getUpstreamById,
  type UpstreamServerRow
} from '../db/queries/upstreams'
import {
  UpstreamOAuthProvider,
  deleteVerifierState,
  readVerifierState,
  type OAuthReturnTarget
} from '../upstream/oauth-provider'
import { refreshCatalogueByUpstreamId } from '../upstream/catalogue'

// SPA paths we're allowed to bounce the user back to after the OAuth
// dance — `return_to=admin` lands them on the admin upstreams page
// instead of /upstreams, so admin onboarding flows don't context-switch.
const RETURN_PATHS: Record<OAuthReturnTarget, string> = {
  user: '/upstreams',
  admin: '/app/admin/upstreams'
}

function parseReturnTo(raw: string | undefined): OAuthReturnTarget {
  return raw === 'admin' ? 'admin' : 'user'
}

function spaReturnUrl(env: Env, target: OAuthReturnTarget): string {
  return new URL(RETURN_PATHS[target], env.PUBLIC_BASE_URL).toString()
}

export const upstreamOauthStartRoute = new Hono<{
  Bindings: Env
  Variables: AuthedVariables
}>()
upstreamOauthStartRoute.use('*', requireUser)

upstreamOauthStartRoute.get('/:id/oauth/start', async (c) => {
  const userId = c.get('user').userId
  const id = c.req.param('id')
  const upstream = await getUpstreamById(c.env, id)
  if (!upstream) return c.json({ error: 'not_found' }, 404)
  if (upstream.auth_strategy !== 'user_oauth') {
    return c.json({ error: 'auth_strategy_mismatch', expected: 'user_oauth' }, 400)
  }
  const returnTo = parseReturnTo(c.req.query('return_to'))

  try {
    return await runStart(c, upstream, userId, returnTo)
  } catch (err) {
    // OAuth error during the refresh attempt — most commonly Notion (or
    // any upstream) rotating / revoking / expiring our stored
    // refresh_token. The SDK re-throws non-ServerError OAuthErrors
    // instead of falling through to startAuthorization, which leaves
    // the user stuck in a 502 loop unless we wipe the bad creds and
    // start a fresh dance. Self-heal once.
    if (err instanceof OAuthError) {
      console.warn(
        `[oauth] ${upstream.slug}: refresh rejected (${err.errorCode ?? 'unknown'}); clearing stored creds and retrying`
      )
      await deleteUserCredential(c.env, userId, upstream.id)
      try {
        return await runStart(c, upstream, userId, returnTo)
      } catch (retryErr) {
        const msg = errMessage(retryErr)
        console.error(`[oauth] ${upstream.slug}: retry after wipe failed: ${msg}`)
        return c.json({ error: 'oauth_start_failed', message: msg }, 502)
      }
    }
    const msg = errMessage(err)
    console.error(`[oauth] ${upstream.slug}: start failed: ${msg}`)
    return c.json({ error: 'oauth_start_failed', message: msg }, 502)
  }
})

type StartCtx = Context<{ Bindings: Env; Variables: AuthedVariables }>

async function runStart(
  c: StartCtx,
  upstream: UpstreamServerRow,
  userId: string,
  returnTo: OAuthReturnTarget,
  // When true (the normal entry), an AUTHORIZED token that turns out to be
  // dead at the upstream's MCP layer triggers a wipe + a forced interactive
  // re-auth. The recursive call passes false to stop after one heal.
  selfHeal = true
) {
  const provider = new UpstreamOAuthProvider(c.env, upstream, userId, undefined, returnTo)
  const result = await mcpAuth(provider, { serverUrl: upstream.url ?? '' })
  if (result === 'AUTHORIZED') {
    // Tokens on file and accepted by auth() (possibly just refreshed).
    // Reconnect doubles as a force-refresh, so re-warm the catalogue — but
    // SYNCHRONOUSLY, because a user_oauth token can satisfy auth() (even a
    // fresh refresh) yet still be rejected by the upstream at the MCP layer
    // with "session expired / re-authenticate" (Linear's -32002). auth()
    // never sees that rejection, so the reconnect silently loops on the
    // refresh path and never prompts a real login. If the probe shows the
    // token is dead, wipe it and fall through to a full interactive
    // authorization (once) — that's the only thing that re-establishes the
    // upstream session.
    const access = (await provider.tokens())?.access_token ?? null
    const probe = await refreshCatalogueByUpstreamId(c.env, upstream.id, access)
    if (probe.ok) {
      console.log(
        `[catalogue] ${probe.slug}: re-warmed ${probe.toolsCount} tools after AUTHORIZED reconnect`
      )
    } else if (selfHeal && isReauthSignal(probe.message)) {
      console.warn(
        `[oauth] ${upstream.slug}: token accepted by auth() but rejected at MCP layer (${probe.reason}); wiping creds + forcing interactive re-auth`
      )
      await deleteUserCredential(c.env, userId, upstream.id)
      return runStart(c, upstream, userId, returnTo, false)
    } else {
      console.warn(
        `[catalogue] ${upstream.slug}: reconnect-AUTHORIZED refresh failed (${probe.reason})${
          probe.message ? `: ${probe.message}` : ''
        }`
      )
    }
    return c.redirect(
      `${spaReturnUrl(c.env, returnTo)}?oauth_connected=${encodeURIComponent(upstream.slug)}`,
      302
    )
  }
  if (!provider.capturedRedirect) {
    // SDK returned 'REDIRECT' but didn't hand us a URL. Defensive: bail.
    return c.json({ error: 'oauth_redirect_missing' }, 500)
  }
  return c.redirect(provider.capturedRedirect.toString(), 302)
}

export const upstreamOauthCallbackRoute = new Hono<{
  Bindings: Env
  Variables: AuthedVariables
}>()
upstreamOauthCallbackRoute.use('*', requireUser)

upstreamOauthCallbackRoute.get('/callback', async (c) => {
  const userId = c.get('user').userId
  const code = c.req.query('code')
  const state = c.req.query('state')
  const errParam = c.req.query('error')

  // returnTo isn't known yet if state is missing/expired; default to
  // the user-side page in that degenerate path so we still land
  // somewhere sensible.
  let returnTo: OAuthReturnTarget = 'user'

  if (errParam) {
    const desc = c.req.query('error_description') ?? ''
    return c.redirect(
      `${spaReturnUrl(c.env, returnTo)}?oauth_error=${encodeURIComponent(errParam)}&desc=${encodeURIComponent(desc)}`,
      302
    )
  }
  if (!code || !state) {
    return c.json({ error: 'oauth_callback_missing_params' }, 400)
  }

  const stored = await readVerifierState(c.env, state)
  if (!stored) return c.json({ error: 'oauth_state_unknown_or_expired' }, 400)
  if (stored.userId !== userId) {
    // Different user finished the dance — refuse to inject tokens
    // into someone else's account.
    return c.json({ error: 'oauth_user_mismatch' }, 403)
  }
  returnTo = stored.returnTo ?? 'user'

  const upstream = await getUpstreamById(c.env, stored.upstreamId)
  if (!upstream) return c.json({ error: 'not_found' }, 404)

  const provider = new UpstreamOAuthProvider(c.env, upstream, userId, state)
  try {
    const result = await mcpAuth(provider, {
      serverUrl: upstream.url ?? '',
      authorizationCode: code
    })
    if (result !== 'AUTHORIZED') {
      return c.json({ error: 'oauth_exchange_did_not_authorize' }, 502)
    }
  } catch (err) {
    console.error(`oauth callback exchange failed for ${upstream.slug}:`, err)
    return c.redirect(
      `${spaReturnUrl(c.env, returnTo)}?oauth_error=exchange&desc=${encodeURIComponent(errMessage(err))}`,
      302
    )
  } finally {
    // One-shot use — drop the verifier even on error so a replay can't
    // reuse it.
    await deleteVerifierState(c.env, state)
  }

  // Warm the tool catalogue immediately so the SPA reflects connection
  // success on reload. Best-effort.
  const access = (await provider.tokens())?.access_token ?? null
  c.executionCtx.waitUntil(
    refreshCatalogueByUpstreamId(c.env, upstream.id, access).then(
      (r) => {
        if (r.ok) {
          console.log(`[catalogue] ${r.slug}: warmed ${r.toolsCount} tools after OAuth`)
        } else {
          console.warn(
            `[catalogue] ${upstream.slug}: post-OAuth refresh failed (${r.reason})${
              r.message ? `: ${r.message}` : ''
            }`
          )
        }
      },
      (err) => {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[catalogue] ${upstream.slug}: post-OAuth refresh threw: ${msg}`)
      }
    )
  )

  return c.redirect(
    `${spaReturnUrl(c.env, returnTo)}?oauth_connected=${encodeURIComponent(upstream.slug)}`,
    302
  )
})

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Does an upstream catalogue-refresh error message signal that the token
 * was rejected for AUTH reasons (so a wipe + re-auth is warranted) vs a
 * transient network/5xx (where wiping creds would be wrong)? Narrow on
 * purpose — we delete stored creds on a match. Linear surfaces a JSON-RPC
 * -32002 "Session expired. Please re-authenticate." at the MCP layer; the
 * generic auth phrases cover other upstreams.
 */
export function isReauthSignal(msg: string | undefined | null): boolean {
  if (!msg) return false
  return /(-32002|session expired|re-?authenticate|invalid[_ ]token|unauthorized|\b401\b)/i.test(msg)
}
