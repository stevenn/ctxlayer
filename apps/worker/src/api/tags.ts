/**
 * Org-wide free-form tag vocabulary. Read-only, signed-in: tags are public
 * metadata (not ACL), so every user sees the same list. Feeds the doc
 * editor's tag autocomplete. The team/product tag kinds have their own
 * `/api/teams` + `/api/products` endpoints; this is only the free-form `tag`.
 */

import { Hono } from 'hono'
import type { TagVocab } from '@ctxlayer/shared'
import type { Env } from '../env'
import { requireUser, type AuthedVariables } from '../auth/middleware'
import { listAllTagValues } from '../db/queries/doc-tags'

export const tagsRoute = new Hono<{ Bindings: Env; Variables: AuthedVariables }>()

tagsRoute.use('*', requireUser)

tagsRoute.get('/', async (c) => {
  const tags: TagVocab = await listAllTagValues(c.env)
  return c.json(tags)
})
