import { OAuthProvider, getOAuthApi } from '@cloudflare/workers-oauth-provider'
import type { Env, QueueName } from './env'
import { app } from './app'
import { oauthProviderOptions } from './oauth/provider-config'
import { usageConsumer } from './queues/usage-consumer'
import { reindexConsumer } from './queues/reindex-consumer'
import { gitSyncConsumer } from './queues/git-sync-consumer'
import { pruneUsageEvents } from './db/queries/usage'
import { pruneOrphanOAuthClients } from './oauth/prune-clients'
import { listEnabledGitSources } from './db/queries/git-sources'
import { isGitSyncDue } from './git/sync'
import { notify } from './ops/alert'
import { LAST_CRON_KV_KEY } from './ops/cron-heartbeat'
import { withHsts } from './util/security-headers'

export { McpSessionDO } from './mcp/session-do'
export { DocRoomDO } from './collab/doc-room-do'

// Route mounting lives in `app.ts` — this module only wraps the composed
// Hono app in the OAuthProvider and the worker handler (HSTS + queue +
// scheduled).

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
    // A configured consumer with no code branch = deploy/config skew. Retry
    // (bounded by max_retries in wrangler.toml) rather than silently drop, and
    // alert so it's not invisible.
    console.error(`unknown queue: ${batch.queue}`)
    await notify(env, { level: 'error', event: 'queue.unknown', detail: String(batch.queue) })
    for (const msg of batch.messages) msg.retry()
  },
  async scheduled(controller, env, ctx) {
    // Liveness heartbeat for /api/health — any cron firing refreshes it, so a
    // stalled scheduler becomes visible (it otherwise emits nothing at all).
    ctx.waitUntil(
      env.OAUTH_KV.put(
        LAST_CRON_KV_KEY,
        String(Math.floor(controller.scheduledTime / 1000))
      ).catch((e) => console.error('[cron] heartbeat write failed', e))
    )
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
            await notify(env, { level: 'error', event: 'cron.git_sync_failed', detail: m })
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
          await notify(env, { level: 'error', event: 'cron.usage_prune_failed', detail: m })
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
          await notify(env, { level: 'error', event: 'cron.oauth_prune_failed', detail: m })
        }
      })()
    )
  }
}

export default worker
