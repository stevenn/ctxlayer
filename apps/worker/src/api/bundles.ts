/**
 * OKF bundle REST surface. Export a folder subtree as a tar.gz / zip archive.
 * Open-read like the rest of the doc GETs (docs are org-wide readable).
 */

import { Hono } from 'hono'
import type { Env } from '../env'
import { type AuthedVariables, requireUser } from '../auth/middleware'
import { requireCsrf } from '../auth/csrf'
import { FolderPath } from '@ctxlayer/shared'
import { isBundleFormat } from '../bundle/archive'
import { composeBundle } from '../bundle/export'
import { importBundle } from '../bundle/import'

export const bundlesRoute = new Hono<{ Bindings: Env; Variables: AuthedVariables }>()

bundlesRoute.use('*', requireUser)
bundlesRoute.use('*', requireCsrf)

// GET /api/bundles/export?root=/specs/api&format=tar.gz
// root omitted / '/' = the whole library.
bundlesRoute.get('/export', async (c) => {
  const root = c.req.query('root') ?? '/'
  const format = c.req.query('format') ?? 'tar.gz'
  if (!isBundleFormat(format)) {
    return c.json({ error: 'bad_format', hint: 'format must be tar.gz or zip' }, 400)
  }
  const out = await composeBundle(c.env, root, format)
  return new Response(out.bytes, {
    status: 200,
    headers: {
      'content-type': out.contentType,
      'content-disposition': `attachment; filename="${out.filename}"`,
      'cache-control': 'no-store'
    }
  })
})

// POST /api/bundles/import?target=/imported&format=tar.gz  (body = archive bytes)
// The archive tree is grafted under `target` (omit for root). Returns a summary.
bundlesRoute.post('/import', async (c) => {
  const format = c.req.query('format') ?? 'tar.gz'
  if (!isBundleFormat(format)) {
    return c.json({ error: 'bad_format', hint: 'format must be tar.gz or zip' }, 400)
  }
  const rawTarget = c.req.query('target')
  let targetFolder: string | null = null
  if (rawTarget && rawTarget !== '/') {
    const parsed = FolderPath.safeParse(rawTarget)
    if (!parsed.success) return c.json({ error: 'bad_target' }, 400)
    targetFolder = parsed.data
  }
  const bytes = new Uint8Array(await c.req.arrayBuffer())
  if (bytes.length === 0) return c.json({ error: 'empty_body' }, 400)
  const { userId } = c.get('user')
  const result = await importBundle(c.env, { bytes, format, targetFolder, createdBy: userId })
  return c.json(result, 201)
})
