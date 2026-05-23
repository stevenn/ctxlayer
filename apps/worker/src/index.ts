import { Hono } from 'hono'
import type { Env, QueueName } from './env'
import { healthRoute } from './api/health'
import { meRoute } from './api/me'
import { versionRoute } from './api/version'
import { configRoute } from './api/config'
import { usageConsumer } from './queues/usage-consumer'
import { reindexConsumer } from './queues/reindex-consumer'

export { McpSessionDO } from './mcp/session-do'
export { DocRoomDO } from './collab/doc-room-do'

const app = new Hono<{ Bindings: Env }>()

app.route('/api/health', healthRoute)
app.route('/api/version', versionRoute)
app.route('/api/me', meRoute)
app.route('/api/config', configRoute)

// Placeholders for routes wired up in later milestones. Both the bare path
// and any subpath need to be matched so MCP clients hitting `/mcp/<session>`
// don't accidentally fall through to the asset resolver.
const m2 = (label: string) => (c: { text: (s: string, status: 501) => Response }) =>
  c.text(`${label} coming in M2`, 501)
app.all('/mcp', m2('MCP endpoint'))
app.all('/mcp/*', m2('MCP endpoint'))
app.all('/sse', m2('SSE endpoint'))
app.all('/sse/*', m2('SSE endpoint'))
app.all('/oauth/*', (c) => c.text('OAuth provider coming in M2', 501))
app.all('/.well-known/oauth-authorization-server', (c) =>
  c.text('OAuth metadata coming in M2', 501)
)
app.all('/idp/*', (c) => c.text('IdP sign-in coming in M1', 501))
app.all('/collab/*', (c) => c.text('Realtime collab coming in M3', 501))

// notFound fires only for paths in `run_worker_first` that no Hono route
// matched (e.g. typo'd `/api/upstreamz`). Return JSON 404 — the SPA shell
// fallback for unknown non-API paths is handled by Workers Assets'
// `not_found_handling = "single-page-application"` in wrangler.toml.
app.notFound((c) => c.json({ error: 'not_found', path: c.req.path }, 404))

const worker: ExportedHandler<Env> = {
  fetch: app.fetch,
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
