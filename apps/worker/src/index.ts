import { Hono } from 'hono'
import { OAuthProvider, getOAuthApi } from '@cloudflare/workers-oauth-provider'
import type { Env, QueueName } from './env'
import { healthRoute } from './api/health'
import { meRoute } from './api/me'
import { versionRoute } from './api/version'
import { configRoute } from './api/config'
import { authRoute } from './api/auth'
import { docsRoute } from './api/docs'
import { docSharingRoute } from './api/doc-sharing'
import { docTagsRoute } from './api/doc-tags'
import { foldersRoute } from './api/folders'
import { searchRoute } from './api/search'
import { gitDocsRoute, gitSourcesUserRoute } from './api/git'
import { usersRoute } from './api/users'
import { teamsRoute, productsRoute, rolesRoute } from './api/teams'
import { adminTeamsRoute } from './api/admin-teams'
import { adminRolesRoute } from './api/admin-roles'
import { adminProductsRoute, adminTeamProductsRoute } from './api/admin-products'
import { adminAuditRoute } from './api/admin-audit'
import { adminOAuthClientsRoute } from './api/admin-oauth-clients'
import { adminUpstreamsRoute } from './api/admin-upstreams'
import { adminGitSourcesRoute } from './api/admin-git-sources'
import { adminDocsRoute } from './api/admin-docs'
import { adminUsersRoute } from './api/admin-users'
import { adminInvitesRoute } from './api/admin-invites'
import { adminJoinCodesRoute } from './api/admin-join-codes'
import { adminUsageRoute } from './api/admin-usage'
import { skillsRoute } from './api/skills'
import { skillAttachmentsRoute } from './api/skill-attachments'
import { skillsExportRoute } from './api/skills-export'
import { skillsDraftContextRoute } from './api/skills-draft-context'
import { docAttachmentsRoute } from './api/doc-attachments'
import { usageRoute } from './api/usage'
import { upstreamsRoute } from './api/upstreams'
import { upstreamOauthCallbackRoute, upstreamOauthStartRoute } from './api/upstream-oauth'
import { googleIdpRoute } from './idp/google'
import { githubIdpRoute } from './idp/github'
import { handleAuthorize } from './oauth/authorize-page'
import { handleCollabUpgrade } from './collab/upgrade'
import { oauthProviderOptions } from './oauth/provider-config'
import { usageConsumer } from './queues/usage-consumer'
import { reindexConsumer } from './queues/reindex-consumer'
import { gitSyncConsumer } from './queues/git-sync-consumer'
import { pruneUsageEvents } from './db/queries/usage'
import { pruneOrphanOAuthClients } from './oauth/prune-clients'
import { listEnabledGitSources } from './db/queries/git-sources'
import { isGitSyncDue } from './git/sync'
import { withHsts } from './util/security-headers'

export { McpSessionDO } from './mcp/session-do'
export { DocRoomDO } from './collab/doc-room-do'

const app = new Hono<{ Bindings: Env }>()

app.route('/api/health', healthRoute)
app.route('/api/version', versionRoute)
app.route('/api/me', meRoute)
app.route('/api/config', configRoute)
app.route('/api/auth', authRoute)
app.route('/api/users', usersRoute)
app.route('/api/teams', teamsRoute)
app.route('/api/products', productsRoute)
app.route('/api/roles', rolesRoute)
// Docs CRUD, per-doc ACL, and tags share the same /api/docs prefix;
// the sub-routers each match disjoint subpaths so mount order does
// not matter.
app.route('/api/docs', docsRoute)
app.route('/api/docs', docSharingRoute)
app.route('/api/docs', docTagsRoute)
// Per-doc git status + write-back (PR). Disjoint subpaths (/:id/git*).
app.route('/api/docs', gitDocsRoute)
// Per-user git credential connect (PAT) for write-back authorship.
app.route('/api/git-sources', gitSourcesUserRoute)
app.route('/api/folders', foldersRoute)
// Semantic search over the doc library (RAG). Shares its core with the
// MCP `search_docs` tool via rag/search.ts.
app.route('/api/search', searchRoute)
// Skills + attachments (M7a). Reads are open to any signed-in user;
// writes are admin-only (per-route requireAdmin inside the routers).
// Mount /export FIRST so it doesn't get captured by /:id matching in
// skillsRoute.
app.route('/api/skills/export', skillsExportRoute)
app.route('/api/skills/draft-context', skillsDraftContextRoute)
app.route('/api/skills', skillsRoute)
app.route('/api/skill-attachments', skillAttachmentsRoute)
app.route('/api/doc-attachments', docAttachmentsRoute)
// Admin REST. All inner routes gate on requireAdmin so non-admins
// hitting these endpoints get 403, not 401.
app.route('/api/admin/teams', adminTeamsRoute)
app.route('/api/admin/roles', adminRolesRoute)
app.route('/api/admin/products', adminProductsRoute)
app.route('/api/admin/team-products', adminTeamProductsRoute)
app.route('/api/admin/upstreams', adminUpstreamsRoute)
app.route('/api/admin/git-sources', adminGitSourcesRoute)
app.route('/api/admin/docs', adminDocsRoute)
app.route('/api/admin/users', adminUsersRoute)
app.route('/api/admin/invites', adminInvitesRoute)
app.route('/api/admin/join-codes', adminJoinCodesRoute)
app.route('/api/admin/audit', adminAuditRoute)
app.route('/api/admin/oauth-clients', adminOAuthClientsRoute)
app.route('/api/admin/usage', adminUsageRoute)

// User-facing usage dashboard read endpoint.
app.route('/api/usage', usageRoute)

// User-facing upstream connections (paste-bearer, list visible). Lives
// at /api/upstreams to mirror the SPA route at /upstreams.
app.route('/api/upstreams', upstreamsRoute)
// Outbound OAuth — `/start` is per-upstream, `/callback` is shared.
// The callback URL must match what we register at DCR time, so the
// path is global to avoid registering a separate client per upstream.
app.route('/api/upstreams', upstreamOauthStartRoute)
app.route('/api/upstreams/oauth', upstreamOauthCallbackRoute)

// IdP sign-in. The SPA hits these from /sign-in; both providers
// redirect back to /app/docs after issuing the session cookie. When
// reached from an MCP-client OAuth flow (?oauth_request_id=...) the
// same callbacks instead call provider.completeAuthorization.
app.route('/idp/google', googleIdpRoute)
app.route('/idp/github', githubIdpRoute)

// /oauth/authorize is the IdP chooser shown to MCP clients. The OAuth
// provider library handles /oauth/token, /oauth/register, and
// /.well-known/oauth-authorization-server itself (see provider config
// below). Everything else under /oauth/ falls through to 404.
app.get('/oauth/authorize', (c) => handleAuthorize(c.req.raw, c.env))

// Realtime collab WebSocket endpoint. The handler authenticates the
// upgrade with the SPA session cookie + canEditDoc and then forwards
// the request to a `DocRoomDO` instance sharded by docId. CSRF does
// not apply: WebSocket handshakes can't send custom headers, the
// upgrade is a same-origin GET, and the DO never accepts state-
// changing HTTP — only WebSocket frames after the upgrade.
app.get('/collab/:docId', (c) => handleCollabUpgrade(c.req.raw, c.env, c.req.param('docId')))

// notFound fires only for paths in `run_worker_first` that no Hono route
// matched. JSON 404 — the SPA shell fallback for unknown non-API paths
// is handled by Workers Assets' `not_found_handling` in wrangler.toml.
app.notFound((c) => c.json({ error: 'not_found', path: c.req.path }, 404))

// OAuthProvider wraps the worker's fetch. It implements /oauth/token,
// /oauth/register, /.well-known/oauth-authorization-server, and gates
// /mcp + /sse on a valid bearer token. Everything else falls through
// to the Hono app (default handler). Provider options live in
// `oauth/provider-config.ts` so admin tooling can construct a
// read-only `OAuthHelpers` against the identical config.
const oauthProvider = new OAuthProvider<Env>(
  oauthProviderOptions({ fetch: app.fetch as ExportedHandler<Env>['fetch'] })
)

const worker: ExportedHandler<Env> = {
  // HSTS on every worker-served response (asset responses get it from
  // dist/_headers — see util/security-headers.ts). Skipped on localhost so
  // dev doesn't pin the browser's whole `localhost` to HTTPS.
  fetch: async (req, env, ctx) => withHsts(req, await oauthProvider.fetch(req, env, ctx)),
  async queue(batch, env, ctx) {
    const queue = batch.queue as QueueName
    if (queue === 'ctxlayer-usage') return usageConsumer(batch, env, ctx)
    if (queue === 'ctxlayer-reindex') return reindexConsumer(batch, env, ctx)
    if (queue === 'ctxlayer-git-sync') return gitSyncConsumer(batch, env, ctx)
    console.error(`unknown queue: ${batch.queue}`)
    for (const msg of batch.messages) msg.retry()
  },
  async scheduled(controller, env, ctx) {
    // Hourly cron (`0 * * * *`): git-sync due-check. Enqueue one message
    // per enabled shared_bearer source whose sync_interval has elapsed.
    // (user_* read strategies have no token without an interactive user,
    // so unattended sync only applies to shared_bearer sources.)
    if (controller.cron === '0 * * * *') {
      ctx.waitUntil(
        (async () => {
          try {
            const sources = await listEnabledGitSources(env)
            const nowSec = Math.floor(controller.scheduledTime / 1000)
            let queued = 0
            for (const s of sources) {
              if (s.read_strategy !== 'shared_bearer') continue
              if (!isGitSyncDue(s.sync_interval, s.last_synced_at, nowSec)) continue
              await env.GIT_SYNC_QUEUE.send({ sourceId: s.id })
              queued++
            }
            console.log(`[cron] git-sync: queued ${queued}/${sources.length} source(s)`)
          } catch (err) {
            const m = err instanceof Error ? err.message : String(err)
            console.error(`[cron] git-sync due-check failed: ${m}`)
          }
        })()
      )
      return
    }

    // Nightly cron (`0 3 * * *`). Each task is independent and wrapped
    // in its own try/catch + waitUntil so a slow/failed one can't time
    // out the trigger or starve the others.

    // 1. Prune raw usage_events older than 30 days (rollups stay forever).
    ctx.waitUntil(
      (async () => {
        try {
          const removed = await pruneUsageEvents(env, 30)
          console.log(`[cron] pruned ${removed} usage_events rows older than 30d`)
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err)
          console.error(`[cron] usage_events prune failed: ${m}`)
        }
      })()
    )

    // 2. Prune abandoned DCR client registrations: public, zero-grant,
    // older than 1 day (the loopback-OAuth retry detritus). Fail-closed
    // if the grant index is incomplete — see oauth/prune-clients.ts.
    ctx.waitUntil(
      (async () => {
        try {
          const helpers = getOAuthApi<Env>(oauthProviderOptions(), env)
          const r = await pruneOrphanOAuthClients(env, helpers, { olderThanDays: 1 })
          if (r.skippedIncompleteIndex) {
            console.warn('[cron] oauth-client prune skipped: grant index incomplete')
          } else {
            console.log(
              `[cron] pruned ${r.deleted}/${r.orphans} orphan oauth clients ` +
                `(scanned ${r.scanned}, ${r.failed} delete failures)`
            )
          }
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err)
          console.error(`[cron] oauth-client prune failed: ${m}`)
        }
      })()
    )
  }
}

export default worker
