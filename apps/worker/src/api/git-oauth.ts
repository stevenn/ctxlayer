/**
 * Friendly git OAuth (static / pre-registered) — the connect flow users hit
 * instead of pasting a PAT.
 *
 *   GET /api/git-sources/:id/oauth/start  — build a provider, try a refresh;
 *     if nothing usable, 302 to the provider's authorize endpoint.
 *   GET /api/git-sources/oauth/callback   — exchange ?code= for tokens (sealed
 *     into git_user_credentials), then bounce back to the doc / admin page.
 *
 * The callback is GLOBAL (not per-source) so one redirect_uri is registered
 * per provider app. These are GETs (redirects), so no CSRF middleware — the
 * one-shot KV `state` is the anti-replay / user-binding guard, mirroring the
 * upstream OAuth routes.
 */

import { Hono } from 'hono'
import type { Env } from '../env'
import { requireUser, type AuthedVariables } from '../auth/middleware'
import { getGitSourceById, isGitSourceVisibleToUser } from '../db/queries/git-sources'
import { getGitConnectionForSource } from '../db/queries/git-connections'
import {
  GitOAuthFlowProvider,
  deleteGitVerifierState,
  gitStaticOAuth,
  readGitVerifierState,
  type GitOAuthReturn
} from '../git/git-oauth'
import { buildAuthorizeRedirect, exchangeCode, refreshStatic } from '../upstream/oauth-static'
import { notFound } from './respond'

/** Build the SPA URL to bounce back to — always from a fixed prefix (no open redirect). */
function returnUrl(env: Env, ret: GitOAuthReturn | undefined, params: string): string {
  const path = ret?.docId
    ? `/app/docs/${encodeURIComponent(ret.docId)}`
    : ret?.admin
      ? '/app/admin/git-sources'
      : '/app/docs'
  return `${new URL(path, env.PUBLIC_BASE_URL).toString()}?${params}`
}

export const gitOauthStartRoute = new Hono<{ Bindings: Env; Variables: AuthedVariables }>()
gitOauthStartRoute.use('*', requireUser)

gitOauthStartRoute.get('/:id/oauth/start', async (c) => {
  const actor = c.get('user')
  const userId = actor.userId
  const source = await getGitSourceById(c.env, c.req.param('id'))
  if (!source) return notFound(c)
  // Same gate as the PAT path (PUT /:id/credentials): sources are
  // invisible-until-granted, so connecting needs a visibility grant too.
  const allowed =
    actor.role === 'admin' || (await isGitSourceVisibleToUser(c.env, source.id, userId))
  if (!allowed) return c.json({ error: 'forbidden' }, 403)
  const connection = await getGitConnectionForSource(c.env, source.id)
  const oauth = gitStaticOAuth(connection?.auth_config ?? null)
  if (!oauth) return c.json({ error: 'oauth_not_configured' }, 400)

  const ret: GitOAuthReturn = {
    docId: c.req.query('doc') || undefined,
    admin: c.req.query('return_to') === 'admin'
  }
  const provider = new GitOAuthFlowProvider(c.env, source, userId, undefined, ret)
  try {
    // Already connected with a still-valid (or refreshable) token → done.
    const access = await refreshStatic(c.env, provider, oauth)
    if (access) {
      return c.redirect(returnUrl(c.env, ret, `git_oauth_connected=${encodeURIComponent(source.slug)}`), 302)
    }
    return c.redirect(await buildAuthorizeRedirect(provider, oauth), 302)
  } catch (err) {
    console.error(`[git-oauth] ${source.slug}: start failed: ${msg(err)}`)
    return c.json({ error: 'oauth_start_failed' }, 502)
  }
})

export const gitOauthCallbackRoute = new Hono<{ Bindings: Env; Variables: AuthedVariables }>()
gitOauthCallbackRoute.use('*', requireUser)

gitOauthCallbackRoute.get('/callback', async (c) => {
  const actor = c.get('user')
  const userId = actor.userId
  const code = c.req.query('code')
  const state = c.req.query('state')
  const errParam = c.req.query('error')

  if (errParam) {
    return c.redirect(returnUrl(c.env, undefined, `git_oauth_error=${encodeURIComponent(errParam)}`), 302)
  }
  if (!code || !state) return c.json({ error: 'oauth_callback_missing_params' }, 400)

  const stored = await readGitVerifierState(c.env, state)
  if (!stored) return c.json({ error: 'oauth_state_unknown_or_expired' }, 400)
  // Anti-pivot: only the user who started the dance may receive the tokens.
  if (stored.userId !== userId) return c.json({ error: 'oauth_user_mismatch' }, 403)

  const source = await getGitSourceById(c.env, stored.gitSourceId)
  if (!source) return notFound(c)
  // Re-check visibility at token time — a grant revoked mid-dance must not
  // still land a credential.
  const allowed =
    actor.role === 'admin' || (await isGitSourceVisibleToUser(c.env, source.id, userId))
  if (!allowed) {
    await deleteGitVerifierState(c.env, state)
    return c.json({ error: 'forbidden' }, 403)
  }
  const connection = await getGitConnectionForSource(c.env, source.id)
  const oauth = gitStaticOAuth(connection?.auth_config ?? null)
  if (!oauth) return c.json({ error: 'oauth_not_configured' }, 400)

  const provider = new GitOAuthFlowProvider(c.env, source, userId, state)
  try {
    await exchangeCode(c.env, provider, oauth, code)
  } catch (err) {
    console.error(`[git-oauth] callback exchange failed for ${source.slug}: ${msg(err)}`)
    return c.redirect(returnUrl(c.env, stored.return, 'git_oauth_error=exchange'), 302)
  } finally {
    // One-shot — drop the verifier even on error so a replay can't reuse it.
    await deleteGitVerifierState(c.env, state)
  }
  return c.redirect(
    returnUrl(c.env, stored.return, `git_oauth_connected=${encodeURIComponent(source.slug)}`),
    302
  )
})

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
