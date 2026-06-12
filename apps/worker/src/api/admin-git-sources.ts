/**
 * Admin REST for `git_sources` (+ visibility, shared read credential,
 * manual sync). Mirrors admin-upstreams.ts: requireAdmin + requireCsrf
 * on every route, slug-unique → 409, hydrate via gitAdminRowFor.
 *
 * Sync is enqueued (not run inline) so a large repo can't time out the
 * request; the row's last_sync_* fields update once the queue consumer
 * finishes, and the SPA re-fetches.
 */

import { Hono } from 'hono'
import {
  CreateGitSourceRequest,
  GitOAuthConfigRequest,
  GitSetCredentialRequest,
  ReplaceVisibilityRequest,
  UpdateGitSourceRequest,
  isSameOrigin
} from '@ctxlayer/shared'
import type { Env } from '../env'
import { requireAdmin, type AuthedVariables } from '../auth/middleware'
import { requireCsrf } from '../auth/csrf'
import {
  createGitSource,
  deleteGitSharedCredential,
  deleteGitSource,
  getGitSourceById,
  gitAdminRowFor,
  listGitDocPaths,
  listGitSources,
  patchGitSource,
  replaceGitSourceVisibility,
  setGitSourceAuthConfig,
  upsertGitSharedCredential
} from '../db/queries/git-sources'
import { parseGitAuthConfig } from '../git/git-oauth'
import { setDocProductTag } from '../db/queries/doc-tags'
import { seal, sealedToString } from '../crypto/aead'
import { audit } from '../audit/log'

export const adminGitSourcesRoute = new Hono<{ Bindings: Env; Variables: AuthedVariables }>()
adminGitSourcesRoute.use('*', requireAdmin)
adminGitSourcesRoute.use('*', requireCsrf)

adminGitSourcesRoute.get('/', async (c) => {
  const userId = c.get('user').userId
  const rows = await listGitSources(c.env)
  const hydrated = await Promise.all(rows.map((r) => gitAdminRowFor(c.env, r.id, userId)))
  return c.json(hydrated.filter((x) => x !== null))
})

adminGitSourcesRoute.get('/:id', async (c) => {
  const row = await gitAdminRowFor(c.env, c.req.param('id'), c.get('user').userId)
  if (!row) return c.json({ error: 'not_found' }, 404)
  return c.json(row)
})

adminGitSourcesRoute.post('/', async (c) => {
  const parsed = CreateGitSourceRequest.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'bad_request', issues: parsed.error.issues }, 400)
  const input = parsed.data
  // GitHub/Azure address repos by owner; reject early with a clear code.
  if ((input.provider === 'github' || input.provider === 'azure') && !input.owner) {
    return c.json({ error: 'owner_required' }, 400)
  }
  // Self-loop guard: base URL must not be this ctxlayer deployment.
  if (input.baseUrl && isSameOrigin(input.baseUrl, c.env.PUBLIC_BASE_URL)) {
    return c.json({ error: 'self_loop', message: 'URL must not point at this ctxlayer instance' }, 400)
  }
  try {
    const row = await createGitSource(c.env, { ...input, createdBy: c.get('user').userId })
    await audit(c.env, {
      actorId: c.get('user').userId,
      action: 'git_source.create',
      target: row.id,
      meta: { slug: row.slug }
    })
    const hydrated = await gitAdminRowFor(c.env, row.id, c.get('user').userId)
    return c.json(hydrated, 201)
  } catch (err) {
    if (isUniqueViolation(err)) return c.json({ error: 'slug_taken' }, 409)
    throw err
  }
})

adminGitSourcesRoute.patch('/:id', async (c) => {
  const id = c.req.param('id')
  const before = await getGitSourceById(c.env, id)
  if (!before) return c.json({ error: 'not_found' }, 404)
  const parsed = UpdateGitSourceRequest.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'bad_request', issues: parsed.error.issues }, 400)
  if (parsed.data.baseUrl && isSameOrigin(parsed.data.baseUrl, c.env.PUBLIC_BASE_URL)) {
    return c.json({ error: 'self_loop', message: 'URL must not point at this ctxlayer instance' }, 400)
  }
  await patchGitSource(c.env, id, parsed.data)
  await audit(c.env, {
    actorId: c.get('user').userId,
    action: 'git_source.update',
    target: id,
    meta: { fields: Object.keys(parsed.data) }
  })

  // Product changed → re-tag every synced doc + reindex so search scope
  // reflects the new product. Done in the background; the admin gets 204
  // immediately. (Sync-time tagging only touches changed files, so a
  // product change needs this sweep to reach unchanged docs.)
  if (parsed.data.productId !== undefined && parsed.data.productId !== before.product_id) {
    const newProduct = parsed.data.productId
    c.executionCtx.waitUntil(
      (async () => {
        const docs = await listGitDocPaths(c.env, id)
        for (const d of docs) {
          await setDocProductTag(c.env, d.id, newProduct)
          await c.env.DOC_REINDEX_QUEUE.send({
            docId: d.id,
            revisionId: d.git_commit_sha ?? 'retag',
            source: 'git'
          })
        }
      })().catch((e) => console.error('git product retag failed', e))
    )
  }
  return new Response(null, { status: 204 })
})

adminGitSourcesRoute.delete('/:id', async (c) => {
  const id = c.req.param('id')
  const row = await getGitSourceById(c.env, id)
  await deleteGitSource(c.env, id)
  if (row) {
    await audit(c.env, {
      actorId: c.get('user').userId,
      action: 'git_source.delete',
      target: id,
      meta: { slug: row.slug }
    })
  }
  return new Response(null, { status: 204 })
})

adminGitSourcesRoute.put('/:id/visibility', async (c) => {
  const id = c.req.param('id')
  if (!(await getGitSourceById(c.env, id))) return c.json({ error: 'not_found' }, 404)
  const parsed = ReplaceVisibilityRequest.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'bad_request', issues: parsed.error.issues }, 400)
  await replaceGitSourceVisibility(c.env, id, parsed.data.rules)
  await audit(c.env, {
    actorId: c.get('user').userId,
    action: 'git_source.visibility_set',
    target: id,
    meta: { rules: parsed.data.rules.length }
  })
  return new Response(null, { status: 204 })
})

/**
 * Set / replace the org-level read PAT. After storing it, kick a sync
 * (when read_strategy is shared_bearer) so the admin sees docs appear
 * without a separate click. Never logs the token.
 */
adminGitSourcesRoute.put('/:id/shared-credentials', async (c) => {
  const id = c.req.param('id')
  const row = await getGitSourceById(c.env, id)
  if (!row) return c.json({ error: 'not_found' }, 404)
  const parsed = GitSetCredentialRequest.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'bad_request', issues: parsed.error.issues }, 400)
  const actor = c.get('user')
  const sealed = await seal(parsed.data.token, c.env.ENCRYPTION_KEY)
  await upsertGitSharedCredential(c.env, id, {
    ciphertext: sealed.ciphertext,
    iv: sealed.iv,
    keyVersion: sealed.keyVersion,
    createdBy: actor.userId
  })
  await audit(c.env, {
    actorId: actor.userId,
    action: 'git_source.shared_token_set',
    target: id,
    meta: { slug: row.slug }
  })
  if (row.read_strategy === 'shared_bearer') {
    c.executionCtx.waitUntil(
      c.env.GIT_SYNC_QUEUE.send({ sourceId: id }).catch((err) =>
        console.error('git-sync enqueue (post-credential) failed', err)
      )
    )
  }
  return new Response(null, { status: 204 })
})

adminGitSourcesRoute.delete('/:id/shared-credentials', async (c) => {
  const id = c.req.param('id')
  const row = await getGitSourceById(c.env, id)
  if (!row) return c.json({ error: 'not_found' }, 404)
  const actor = c.get('user')
  await deleteGitSharedCredential(c.env, id)
  await audit(c.env, {
    actorId: actor.userId,
    action: 'git_source.shared_token_clear',
    target: id,
    meta: { slug: row.slug }
  })
  return new Response(null, { status: 204 })
})

/**
 * Configure the source's static (pre-registered) OAuth client so users can
 * connect via OAuth instead of pasting a PAT. The write-only `clientSecret` is
 * sealed into `clientSecretCiphertext` and stripped; on edit with no new
 * secret the existing sealed value is carried forward. The whole auth_config
 * column is replaced, and the read path redacts the ciphertext.
 */
adminGitSourcesRoute.put('/:id/oauth', async (c) => {
  const id = c.req.param('id')
  const row = await getGitSourceById(c.env, id)
  if (!row) return c.json({ error: 'not_found' }, 404)
  const parsed = GitOAuthConfigRequest.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'bad_request', issues: parsed.error.issues }, 400)
  const input = parsed.data
  if (isSameOrigin(input.tokenUrl, c.env.PUBLIC_BASE_URL)) {
    return c.json({ error: 'self_loop', message: 'URL must not point at this ctxlayer instance' }, 400)
  }

  const current = parseGitAuthConfig(row.auth_config)
  let clientSecretCiphertext = current.oauth?.clientSecretCiphertext
  if (input.clientSecret) {
    clientSecretCiphertext = sealedToString(await seal(input.clientSecret, c.env.ENCRYPTION_KEY))
  }
  const authConfig = {
    ...current,
    oauth: {
      clientId: input.clientId,
      authorizeUrl: input.authorizeUrl,
      tokenUrl: input.tokenUrl,
      scopes: input.scopes,
      ...(clientSecretCiphertext ? { clientSecretCiphertext } : {})
    }
  }
  await setGitSourceAuthConfig(c.env, id, JSON.stringify(authConfig))
  await audit(c.env, {
    actorId: c.get('user').userId,
    action: 'git_source.oauth_config',
    target: id,
    meta: { slug: row.slug, clientId: input.clientId }
  })
  return new Response(null, { status: 204 })
})

adminGitSourcesRoute.delete('/:id/oauth', async (c) => {
  const id = c.req.param('id')
  const row = await getGitSourceById(c.env, id)
  if (!row) return c.json({ error: 'not_found' }, 404)
  await setGitSourceAuthConfig(c.env, id, null)
  await audit(c.env, {
    actorId: c.get('user').userId,
    action: 'git_source.oauth_clear',
    target: id,
    meta: { slug: row.slug }
  })
  return new Response(null, { status: 204 })
})

/**
 * Manual "Sync now". Enqueues one git-sync message carrying the calling
 * admin's id (so user_* read strategies resolve their token). Returns
 * 202; the SPA re-fetches the row to see updated last_sync_* fields.
 */
adminGitSourcesRoute.post('/:id/sync', async (c) => {
  const id = c.req.param('id')
  if (!(await getGitSourceById(c.env, id))) return c.json({ error: 'not_found' }, 404)
  await c.env.GIT_SYNC_QUEUE.send({ sourceId: id, userId: c.get('user').userId })
  return c.json({ queued: true }, 202)
})

function isUniqueViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /UNIQUE constraint failed/i.test(msg)
}
