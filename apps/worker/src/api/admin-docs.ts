/**
 * Admin maintenance for the doc search index.
 *
 * POST /reindex rebuilds the Vectorize index for every doc — used after
 * a chunking/embedding change (e.g. embedding the title into each chunk).
 * It enqueues one reindex message per doc; the queue consumer does the
 * work, so this returns immediately.
 */

import { Hono } from 'hono'
import type { Env } from '../env'
import { requireAdmin, type AuthedVariables } from '../auth/middleware'
import { requireCsrf } from '../auth/csrf'
import { listDocsForReindex } from '../db/queries/docs'

export const adminDocsRoute = new Hono<{ Bindings: Env; Variables: AuthedVariables }>()
adminDocsRoute.use('*', requireAdmin)
adminDocsRoute.use('*', requireCsrf)

adminDocsRoute.post('/reindex', async (c) => {
  const docs = await listDocsForReindex(c.env)
  // force: bypasses the consumer's unchanged-content skip — a full
  // rebuild exists precisely to re-embed content whose hash hasn't moved.
  const messages = docs.flatMap((d) => {
    if (d.git_source_id) {
      return [
        {
          body: {
            docId: d.id,
            revisionId: d.git_commit_sha ?? 'reindex',
            source: 'git',
            force: true
          }
        }
      ]
    }
    if (d.current_rev_id) {
      return [{ body: { docId: d.id, revisionId: d.current_rev_id, force: true } }]
    }
    // Authored doc that was never saved → nothing to index.
    return []
  })
  // Cloudflare Queues sendBatch caps at 100 messages per call.
  for (let i = 0; i < messages.length; i += 100) {
    await c.env.DOC_REINDEX_QUEUE.sendBatch(messages.slice(i, i + 100))
  }
  return c.json({ queued: messages.length, total: docs.length })
})
