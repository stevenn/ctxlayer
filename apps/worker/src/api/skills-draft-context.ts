/**
 * GET /api/skills/draft-context?upstreams=<slug,slug>&tool=<name>&prompt=<text>
 *   (single `upstream=<slug>` is still accepted for back-compat)
 *
 * SPA-facing surface for the `ctxlayer draft-skill` context bundle.
 * Admin-gated; no LLM is invoked on the worker. The bundle assembly is
 * shared with the bearer-gated CLI handler — see
 * `skills/draft-context.ts` for what goes in it.
 */

import { Hono } from 'hono'
import type { Env } from '../env'
import { requireAdmin, type AuthedVariables } from '../auth/middleware'
import { buildDraftContext, parseUpstreamSlugs } from '../skills/draft-context'

export const skillsDraftContextRoute = new Hono<{
  Bindings: Env
  Variables: AuthedVariables
}>()
skillsDraftContextRoute.use('*', requireAdmin)

skillsDraftContextRoute.get('/', async (c) => {
  const upstreamSlugs = parseUpstreamSlugs(c.req.query('upstreams'), c.req.query('upstream'))
  if (upstreamSlugs.length === 0) return c.json({ error: 'missing_upstream' }, 400)
  const result = await buildDraftContext(c.env, {
    upstreamSlugs,
    toolName: c.req.query('tool'),
    operatorPrompt: c.req.query('prompt') ?? null,
    userId: c.get('user').userId
  })
  if (!result.ok) return c.json({ error: result.error }, result.status)
  return c.json(result.bundle)
})
