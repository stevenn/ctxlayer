/**
 * User-facing REST for the tools directory (`/app/tools`):
 *
 * - `GET /api/tools` — the org's built-in tools + every visible upstream's
 *   cached tools grouped by family, with per-tool ACL-restricted state.
 *
 * Read-only (GET ⇒ no CSRF), gated on `requireUser`. The whole payload is
 * assembled by `buildToolsDirectory`; this handler stays SQL-free.
 */

import { Hono } from 'hono'
import type { Env } from '../env'
import { requireUser, type AuthedVariables } from '../auth/middleware'
import { buildToolsDirectory } from './tools-directory'

export const toolsRoute = new Hono<{ Bindings: Env; Variables: AuthedVariables }>()
toolsRoute.use('*', requireUser)

toolsRoute.get('/', async (c) => {
  const userId = c.get('user').userId
  return c.json(await buildToolsDirectory(c.env, userId))
})
