/**
 * Admin CRUD for products + the team↔product matrix. All routes
 * gated by `requireAdmin`. The matrix PUT replaces the entire set
 * in one transaction (per PLAN.md F6).
 */

import { Hono } from 'hono'
import { CreateProductRequest, TeamProductsPayload, UpdateProductRequest } from '@ctxlayer/shared'
import type { Env } from '../env'
import { requireAdmin, type AuthedVariables } from '../auth/middleware'
import { requireCsrf } from '../auth/csrf'
import { audit } from '../audit/log'
import {
  createProduct,
  deleteProduct,
  getProductById,
  listProducts,
  listTeamProducts,
  patchProduct,
  replaceTeamProducts,
  toProductRef
} from '../db/queries/products'

export const adminProductsRoute = new Hono<{ Bindings: Env; Variables: AuthedVariables }>()
adminProductsRoute.use('*', requireAdmin)
adminProductsRoute.use('*', requireCsrf)

adminProductsRoute.get('/', async (c) => c.json(await listProducts(c.env)))

adminProductsRoute.post('/', async (c) => {
  const parsed = CreateProductRequest.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'bad_request', issues: parsed.error.issues }, 400)
  try {
    const row = await createProduct(c.env, parsed.data)
    await audit(c.env, {
      actorId: c.get('user').userId,
      action: 'product.create',
      target: row.id,
      meta: { slug: parsed.data.slug }
    })
    return c.json(toProductRef(row), 201)
  } catch (err) {
    if (isUniqueViolation(err)) return c.json({ error: 'slug_taken' }, 409)
    throw err
  }
})

adminProductsRoute.patch('/:id', async (c) => {
  const id = c.req.param('id')
  if (!(await getProductById(c.env, id))) return c.json({ error: 'not_found' }, 404)
  const parsed = UpdateProductRequest.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'bad_request', issues: parsed.error.issues }, 400)
  try {
    await patchProduct(c.env, id, parsed.data)
    await audit(c.env, {
      actorId: c.get('user').userId,
      action: 'product.update',
      target: id,
      meta: { fields: Object.keys(parsed.data) }
    })
    return new Response(null, { status: 204 })
  } catch (err) {
    if (isUniqueViolation(err)) return c.json({ error: 'slug_taken' }, 409)
    throw err
  }
})

adminProductsRoute.delete('/:id', async (c) => {
  const id = c.req.param('id')
  const row = await getProductById(c.env, id)
  await deleteProduct(c.env, id)
  if (row) {
    await audit(c.env, {
      actorId: c.get('user').userId,
      action: 'product.delete',
      target: id,
      meta: { slug: row.slug }
    })
  }
  return new Response(null, { status: 204 })
})

// ----- teams ↔ products matrix -------------------------------------------

export const adminTeamProductsRoute = new Hono<{
  Bindings: Env
  Variables: AuthedVariables
}>()
adminTeamProductsRoute.use('*', requireAdmin)
adminTeamProductsRoute.use('*', requireCsrf)

adminTeamProductsRoute.get('/', async (c) => c.json(await listTeamProducts(c.env)))

adminTeamProductsRoute.put('/', async (c) => {
  const parsed = TeamProductsPayload.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'bad_request', issues: parsed.error.issues }, 400)
  await replaceTeamProducts(c.env, parsed.data.rules)
  await audit(c.env, {
    actorId: c.get('user').userId,
    action: 'product.team_links_set',
    target: null,
    meta: { rules: parsed.data.rules.length }
  })
  return new Response(null, { status: 204 })
})

function isUniqueViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /UNIQUE constraint failed/i.test(msg)
}
