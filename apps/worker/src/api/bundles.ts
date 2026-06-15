/**
 * OKF bundle REST surface. Export a folder subtree as a tar.gz / zip archive.
 * Open-read like the rest of the doc GETs (docs are org-wide readable).
 */

import { Hono } from 'hono'
import type { Env } from '../env'
import { type AuthedVariables, requireUser } from '../auth/middleware'
import { requireCsrf } from '../auth/csrf'
import { isBundleFormat } from '../bundle/archive'
import { composeBundle } from '../bundle/export'

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
