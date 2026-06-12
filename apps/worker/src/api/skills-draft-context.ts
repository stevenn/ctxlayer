/**
 * GET /api/skills/draft-context?upstream=<slug>&tool=<name>&prompt=<text>
 *
 * SPA-facing surface for the `ctxlayer draft-skill` context bundle.
 * Admin-gated; no LLM is invoked on the worker. The bundle assembly is
 * shared with the bearer-gated CLI handler — see
 * `skills/draft-context.ts` for what goes in it.
 */

import { Hono } from 'hono'
import type { Env } from '../env'
import { requireAdmin, type AuthedVariables } from '../auth/middleware'
import { buildDraftContext } from '../skills/draft-context'

export const skillsDraftContextRoute = new Hono<{
  Bindings: Env
  Variables: AuthedVariables
}>()
skillsDraftContextRoute.use('*', requireAdmin)

skillsDraftContextRoute.get('/', async (c) => {
  const upstreamSlug = c.req.query('upstream')
  if (!upstreamSlug) return c.json({ error: 'missing_upstream' }, 400)
  const result = await buildDraftContext(c.env, {
    upstreamSlug,
    toolName: c.req.query('tool'),
    operatorPrompt: c.req.query('prompt') ?? null,
    userId: c.get('user').userId
  })
  if (!result.ok) return c.json({ error: result.error }, result.status)
  return c.json(result.bundle)
})
