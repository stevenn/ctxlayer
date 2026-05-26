import { Hono } from 'hono'
import { OAuthProvider } from '@cloudflare/workers-oauth-provider'
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
import { usersRoute } from './api/users'
import { teamsRoute, productsRoute } from './api/teams'
import { adminTeamsRoute } from './api/admin-teams'
import { adminProductsRoute, adminTeamProductsRoute } from './api/admin-products'
import { adminAuditRoute } from './api/admin-audit'
import { adminUpstreamsRoute } from './api/admin-upstreams'
import { adminUsersRoute } from './api/admin-users'
import { upstreamsRoute } from './api/upstreams'
import {
  upstreamOauthCallbackRoute,
  upstreamOauthStartRoute
} from './api/upstream-oauth'
import { googleIdpRoute } from './idp/google'
import { githubIdpRoute } from './idp/github'
import { handleAuthorize } from './oauth/authorize-page'
import { handleCollabUpgrade } from './collab/upgrade'
import { McpSessionDO } from './mcp/session-do'
import { usageConsumer } from './queues/usage-consumer'
import { reindexConsumer } from './queues/reindex-consumer'

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
// Docs CRUD, per-doc ACL, and tags share the same /api/docs prefix;
// the sub-routers each match disjoint subpaths so mount order does
// not matter.
app.route('/api/docs', docsRoute)
app.route('/api/docs', docSharingRoute)
app.route('/api/docs', docTagsRoute)
app.route('/api/folders', foldersRoute)
// Admin REST. All inner routes gate on requireAdmin so non-admins
// hitting these endpoints get 403, not 401.
app.route('/api/admin/teams', adminTeamsRoute)
app.route('/api/admin/products', adminProductsRoute)
app.route('/api/admin/team-products', adminTeamProductsRoute)
app.route('/api/admin/upstreams', adminUpstreamsRoute)
app.route('/api/admin/users', adminUsersRoute)
app.route('/api/admin/audit', adminAuditRoute)

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
// to the Hono app (default handler). The McpSessionDO's `serve` /
// `serveSSE` helpers return ExportedHandler-shaped wrappers that
// route the request to a DO instance per session.
const oauthProvider = new OAuthProvider<Env>({
  apiHandlers: {
    '/mcp': McpSessionDO.serve('/mcp', { binding: 'MCP_SESSION_DO' }),
    '/sse': McpSessionDO.serveSSE('/sse', { binding: 'MCP_SESSION_DO' })
  },
  defaultHandler: { fetch: app.fetch as ExportedHandler<Env>['fetch'] },
  authorizeEndpoint: '/oauth/authorize',
  tokenEndpoint: '/oauth/token',
  clientRegistrationEndpoint: '/oauth/register',
  scopesSupported: ['mcp']
})

const worker: ExportedHandler<Env> = {
  fetch: (req, env, ctx) => oauthProvider.fetch(req, env, ctx),
  async queue(batch, env, ctx) {
    const queue = batch.queue as QueueName
    if (queue === 'ctxlayer-usage') return usageConsumer(batch, env, ctx)
    if (queue === 'ctxlayer-reindex') return reindexConsumer(batch, env, ctx)
    console.error(`unknown queue: ${batch.queue}`)
    for (const msg of batch.messages) msg.retry()
  },
  async scheduled(_controller, _env, _ctx) {
    // Nightly cron lands here in M6 (prune usage_events, refresh
    // upstream_tools catalogue). No-op for now.
  }
}

export default worker
