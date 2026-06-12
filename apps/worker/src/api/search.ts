/**
 * Semantic doc search for the SPA. POST (not GET): the body carries the
 * query + optional scope, plays nicely with CSRF, and leaves room for
 * the LLM query-understanding round-trip without URL-length limits.
 *
 * Open to every signed-in user — the same open-read stance as
 * `GET /api/docs`. Scope only shapes which chunks rank, it does not gate
 * read access; `runSearch` re-intersects any supplied scope with the
 * caller's reachable set so a request can't escalate.
 */

import { Hono } from 'hono'
import { SearchRequest } from '@ctxlayer/shared'
import type { Env } from '../env'
import { requireUser, type AuthedVariables } from '../auth/middleware'
import { requireCsrf } from '../auth/csrf'
import { runSearch } from '../rag/search'
import { parseJsonBody } from './respond'

export const searchRoute = new Hono<{ Bindings: Env; Variables: AuthedVariables }>()

searchRoute.use('*', requireUser)
searchRoute.use('*', requireCsrf)

searchRoute.post('/', async (c) => {
  const parsed = await parseJsonBody(c, SearchRequest)
  if (!parsed.ok) return parsed.res
  const { userId } = c.get('user')
  const body = await runSearch(c.env, userId, parsed.data)
  return c.json(body)
})
