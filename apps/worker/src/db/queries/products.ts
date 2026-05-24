/**
 * D1 queries for `products` and `team_products`. /api/products read
 * is signed-in only; CRUD + matrix mutations are admin-gated at the
 * route layer.
 */

import type { Env } from '../../env'
import type { ProductRef, TeamProductsAssignment } from '@ctxlayer/shared'

interface ProductRow {
  id: string
  slug: string
  display_name: string
  description: string | null
  created_at: number
  updated_at: number
}

export function toProductRef(row: ProductRow): ProductRef {
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
    description: row.description
  }
}

export async function listProducts(env: Env): Promise<ProductRef[]> {
  const res = await env.DB.prepare(
    `SELECT id, slug, display_name, description, created_at, updated_at
     FROM products ORDER BY display_name`
  ).all<ProductRow>()
  return (res.results ?? []).map(toProductRef)
}

export async function getProductById(env: Env, id: string): Promise<ProductRow | null> {
  const row = await env.DB.prepare(
    `SELECT id, slug, display_name, description, created_at, updated_at
     FROM products WHERE id = ?1`
  )
    .bind(id)
    .first<ProductRow>()
  return row ?? null
}

export interface CreateProductInput {
  slug: string
  displayName: string
  description?: string | null
}

export async function createProduct(env: Env, input: CreateProductInput): Promise<ProductRow> {
  const id = newId()
  const now = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO products (id, slug, display_name, description, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?5)`
  )
    .bind(id, input.slug, input.displayName, input.description ?? null, now)
    .run()
  const row = await getProductById(env, id)
  if (!row) throw new Error('product_insert_lost')
  return row
}

export interface PatchProductInput {
  slug?: string
  displayName?: string
  description?: string | null
}

export async function patchProduct(
  env: Env,
  id: string,
  patch: PatchProductInput
): Promise<void> {
  const fields: string[] = []
  const binds: unknown[] = []
  if (patch.slug !== undefined) {
    fields.push(`slug = ?${fields.length + 1}`)
    binds.push(patch.slug)
  }
  if (patch.displayName !== undefined) {
    fields.push(`display_name = ?${fields.length + 1}`)
    binds.push(patch.displayName)
  }
  if (patch.description !== undefined) {
    fields.push(`description = ?${fields.length + 1}`)
    binds.push(patch.description)
  }
  if (fields.length === 0) return
  fields.push(`updated_at = ?${fields.length + 1}`)
  binds.push(Math.floor(Date.now() / 1000))
  binds.push(id)
  await env.DB.prepare(`UPDATE products SET ${fields.join(', ')} WHERE id = ?${binds.length}`)
    .bind(...binds)
    .run()
}

export async function deleteProduct(env: Env, id: string): Promise<void> {
  // CASCADE on team_products + on doc_tags rows that referenced this id.
  await env.DB.prepare(`DELETE FROM products WHERE id = ?1`).bind(id).run()
}

// ----- team_products matrix ----------------------------------------------

export async function listTeamProducts(env: Env): Promise<TeamProductsAssignment[]> {
  const res = await env.DB.prepare(`SELECT team_id, product_id FROM team_products`).all<{
    team_id: string
    product_id: string
  }>()
  return (res.results ?? []).map((r) => ({ teamId: r.team_id, productId: r.product_id }))
}

/**
 * Replace the entire team_products matrix in one batch. PUT semantics:
 * the supplied set is the new truth; missing pairs are removed.
 */
export async function replaceTeamProducts(
  env: Env,
  rules: TeamProductsAssignment[]
): Promise<void> {
  const stmts: D1PreparedStatement[] = [env.DB.prepare(`DELETE FROM team_products`)]
  for (const r of rules) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO team_products (team_id, product_id) VALUES (?1, ?2)
         ON CONFLICT (team_id, product_id) DO NOTHING`
      ).bind(r.teamId, r.productId)
    )
  }
  await env.DB.batch(stmts)
}

function newId(): string {
  return crypto.randomUUID().replace(/-/g, '')
}
