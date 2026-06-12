/**
 * User-facing git endpoints:
 *   GET  /api/docs/:id/git              — per-doc git status (+ live PR poll)
 *   POST /api/docs/:id/git/pull-request — open/refresh a write-back PR
 *   PUT  /api/git-sources/:id/credentials    — connect a personal PAT
 *   DELETE /api/git-sources/:id/credentials  — disconnect
 *
 * Write-back is gated by canEditDoc (the doc ACL). Per-user creds are
 * gated by source visibility (or admin). Never logs token material.
 */

import { Hono } from 'hono'
import {
  CreatePullRequestRequest,
  GitSetCredentialRequest,
  type GitDocStatus
} from '@ctxlayer/shared'
import type { Env } from '../env'
import { requireUser, type AuthedVariables } from '../auth/middleware'
import { requireCsrf } from '../auth/csrf'
import { canEditDoc, getDocById } from '../db/queries/docs'
import { readSourceMarkdown } from '../storage/docs-r2'
import {
  deleteGitUserCredential,
  getDocGitOrigin,
  getGitSourceById,
  getLatestPrForDoc,
  isGitSourceVisibleToUser,
  setDocGitSyncState,
  updateGitPrState,
  upsertGitUserCredential,
  type GitSourceRow
} from '../db/queries/git-sources'
import { createGitProvider, type GitRepoConfig } from '../git/provider'
import { resolveGitReadToken } from '../git/credentials'
import { openWriteBackPr, prepareWriteBackRedirect } from '../git/writeback'
import { gitStaticOAuth } from '../git/git-oauth'
import { seal } from '../crypto/aead'

function repoConfig(s: GitSourceRow): GitRepoConfig {
  return {
    provider: s.provider,
    baseUrl: s.base_url,
    owner: s.owner,
    project: s.project,
    repo: s.repo
  }
}

// ----- doc-scoped (/api/docs) --------------------------------------------

export const gitDocsRoute = new Hono<{ Bindings: Env; Variables: AuthedVariables }>()
gitDocsRoute.use('*', requireUser)
gitDocsRoute.use('*', requireCsrf)

gitDocsRoute.get('/:id/git', async (c) => {
  const id = c.req.param('id')
  const origin = await getDocGitOrigin(c.env, id)
  if (!origin) return c.json({ error: 'not_a_git_doc' }, 404)
  const source = await getGitSourceById(c.env, origin.git_source_id)
  if (!source) return c.json({ error: 'source_gone' }, 404)

  const userId = c.get('user').userId
  const canWrite = await canEditDoc(c.env, userId, id)
  const webUrl = createGitProvider(repoConfig(source), '').blobWebUrl(
    origin.git_path,
    source.branch
  )

  let syncState = origin.git_sync_state
  const latest = await getLatestPrForDoc(c.env, id)
  let pr = latest
    ? { url: latest.url, providerPrId: latest.provider_pr_id, state: latest.state }
    : null

  // Best-effort live refresh while a PR is open (no webhooks).
  if (latest && latest.state === 'open') {
    const token = await resolveGitReadToken(c.env, source, { userId })
    if (token) {
      try {
        const live = await createGitProvider(repoConfig(source), token).getPullRequestState(
          latest.provider_pr_id
        )
        if (live !== latest.state) {
          await updateGitPrState(c.env, latest.id, live)
          pr = { url: latest.url, providerPrId: latest.provider_pr_id, state: live }
          if (live === 'merged' || live === 'closed') {
            await setDocGitSyncState(c.env, id, 'clean')
            syncState = 'clean'
          }
        }
      } catch {
        // keep the stored state on a poll failure
      }
    }
  }

  const body: GitDocStatus = {
    gitSourceId: source.id,
    sourceSlug: source.slug,
    provider: source.provider,
    branch: source.branch,
    path: origin.git_path,
    webUrl,
    syncState,
    syncedAt: origin.git_synced_at,
    canWrite,
    oauthConfigured: gitStaticOAuth(source) !== null,
    pr
  }
  return c.json(body)
})

// Canonical raw markdown for a git doc — the editor parses this into
// BlockNote blocks lazily on first open (no server-side md→blocks).
// Open-read like all docs.
gitDocsRoute.get('/:id/git/source', async (c) => {
  const id = c.req.param('id')
  if (!(await getDocById(c.env, id))) return c.json({ error: 'not_found' }, 404)
  const origin = await getDocGitOrigin(c.env, id)
  if (!origin) return c.json({ error: 'not_a_git_doc' }, 404)
  const markdown = (await readSourceMarkdown(c.env, id)) ?? ''
  return c.json({ markdown })
})

gitDocsRoute.post('/:id/git/pull-request', async (c) => {
  const id = c.req.param('id')
  const userId = c.get('user').userId
  if (!(await canEditDoc(c.env, userId, id))) return c.json({ error: 'forbidden' }, 403)
  const parsed = CreatePullRequestRequest.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'bad_request', issues: parsed.error.issues }, 400)
  const outcome = await openWriteBackPr(c.env, id, {
    actorId: userId,
    markdown: parsed.data.markdown
  })
  if (!outcome.ok) return c.json({ error: outcome.error }, outcome.status as 400 | 404 | 502)
  return c.json(outcome.result)
})

// Commit the branch, then return the provider's New-PR deep-link for the user
// to review + open in the provider UI (no PR opened by us, no local mutation).
gitDocsRoute.post('/:id/git/review-url', async (c) => {
  const id = c.req.param('id')
  const userId = c.get('user').userId
  if (!(await canEditDoc(c.env, userId, id))) return c.json({ error: 'forbidden' }, 403)
  const parsed = CreatePullRequestRequest.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'bad_request', issues: parsed.error.issues }, 400)
  const outcome = await prepareWriteBackRedirect(c.env, id, {
    actorId: userId,
    markdown: parsed.data.markdown
  })
  if (!outcome.ok) return c.json({ error: outcome.error }, outcome.status as 400 | 404 | 502)
  return c.json(outcome.result)
})

// ----- per-user credentials (/api/git-sources) ---------------------------

export const gitSourcesUserRoute = new Hono<{ Bindings: Env; Variables: AuthedVariables }>()
gitSourcesUserRoute.use('*', requireUser)
gitSourcesUserRoute.use('*', requireCsrf)

gitSourcesUserRoute.put('/:id/credentials', async (c) => {
  const id = c.req.param('id')
  const actor = c.get('user')
  const source = await getGitSourceById(c.env, id)
  if (!source) return c.json({ error: 'not_found' }, 404)
  const allowed =
    actor.role === 'admin' || (await isGitSourceVisibleToUser(c.env, id, actor.userId))
  if (!allowed) return c.json({ error: 'forbidden' }, 403)
  const parsed = GitSetCredentialRequest.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'bad_request', issues: parsed.error.issues }, 400)
  const sealed = await seal(parsed.data.token, c.env.ENCRYPTION_KEY)
  await upsertGitUserCredential(c.env, actor.userId, id, {
    kind: 'bearer',
    ciphertext: sealed.ciphertext,
    iv: sealed.iv,
    keyVersion: sealed.keyVersion
  })
  return new Response(null, { status: 204 })
})

gitSourcesUserRoute.delete('/:id/credentials', async (c) => {
  const actor = c.get('user')
  await deleteGitUserCredential(c.env, actor.userId, c.req.param('id'))
  return new Response(null, { status: 204 })
})
