import { Hono } from 'hono'
import type { Env, QueueName } from './env'
import { healthRoute } from './api/health'
import { meRoute } from './api/me'
import { versionRoute } from './api/version'
import { usageConsumer } from './queues/usage-consumer'
import { reindexConsumer } from './queues/reindex-consumer'

// Re-export Durable Object classes so wrangler can wire them up.
export { McpSessionDO } from './mcp/session-do'
export { DocRoomDO } from './collab/doc-room-do'

const app = new Hono<{ Bindings: Env }>()

app.route('/api/health', healthRoute)
app.route('/api/version', versionRoute)
app.route('/api/me', meRoute)

// Placeholders for routes that arrive in later milestones.
app.all('/mcp', (c) => c.text('MCP endpoint coming in M2', 501))
app.all('/sse', (c) => c.text('SSE endpoint coming in M2', 501))
app.all('/oauth/*', (c) => c.text('OAuth provider coming in M2', 501))
app.all('/idp/*', (c) => c.text('IdP sign-in coming in M1', 501))
app.all('/collab/*', (c) => c.text('Realtime collab coming in M3', 501))
app.all(
  '/.well-known/oauth-authorization-server',
  (c) => c.text('OAuth metadata coming in M2', 501)
)

// Anything else falls through to the SPA shell via Workers Assets.
app.notFound(async (c) => {
  const res = await c.env.ASSETS.fetch(c.req.raw)
  if (res.status === 404) {
    // SPA client-side routing: return index.html for unknown paths.
    const url = new URL(c.req.url)
    url.pathname = '/index.html'
    return c.env.ASSETS.fetch(new Request(url.toString(), c.req.raw))
  }
  return res
})

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    const queue = batch.queue as QueueName
    if (queue === 'ctxlayer-usage') return usageConsumer(batch as MessageBatch, env)
    if (queue === 'ctxlayer-reindex') return reindexConsumer(batch as MessageBatch, env)
  },
  async scheduled(_event: ScheduledEvent, _env: Env, _ctx: ExecutionContext): Promise<void> {
    // Nightly cron lands here in M6. No-op for now.
  }
}
