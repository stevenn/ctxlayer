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

import { Hono } from 'hono'
import { auth as mcpAuth } from '@modelcontextprotocol/sdk/client/auth.js'
import type { Env } from '../env'
import { requireUser, type AuthedVariables } from '../auth/middleware'
import { getUpstreamById } from '../db/queries/upstreams'
import {
  UpstreamOAuthProvider,
  deleteVerifierState,
  readVerifierState
} from '../upstream/oauth-provider'
import { refreshCatalogueByUpstreamId } from '../upstream/catalogue'

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

  const provider = new UpstreamOAuthProvider(c.env, upstream, userId)
  try {
    const result = await mcpAuth(provider, { serverUrl: upstream.url ?? '' })
    if (result === 'AUTHORIZED') {
      // Tokens already on file and valid — nothing to do.
      return c.redirect(spaUpstreamsUrl(c.env), 302)
    }
    if (!provider.capturedRedirect) {
      // SDK returned 'REDIRECT' but didn't hand us a URL. Defensive: bail.
      return c.json({ error: 'oauth_redirect_missing' }, 500)
    }
    return c.redirect(provider.capturedRedirect.toString(), 302)
  } catch (err) {
    console.error(`oauth start failed for upstream ${upstream.slug}:`, err)
    return c.json({ error: 'oauth_start_failed', message: errMessage(err) }, 502)
  }
})

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
  if (errParam) {
    const desc = c.req.query('error_description') ?? ''
    return c.redirect(
      `${spaUpstreamsUrl(c.env)}?oauth_error=${encodeURIComponent(errParam)}&desc=${encodeURIComponent(desc)}`,
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
      `${spaUpstreamsUrl(c.env)}?oauth_error=exchange&desc=${encodeURIComponent(errMessage(err))}`,
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

  return c.redirect(`${spaUpstreamsUrl(c.env)}?oauth_connected=${encodeURIComponent(upstream.slug)}`, 302)
})

function spaUpstreamsUrl(env: Env): string {
  return new URL('/upstreams', env.PUBLIC_BASE_URL).toString()
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
