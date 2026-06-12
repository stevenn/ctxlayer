/**
 * D1 queries for `roles` and `user_roles`. Roles are the cross-cutting
 * org axis (engineering, qa, product) — orthogonal to teams. The
 * /api/roles reader is signed-in only; CRUD + assignment is gated to
 * admins at the route layer. Mirrors `teams.ts`.
 */

import type { Env } from '../../env'
import type { AdminRoleRow, RoleRef } from '@ctxlayer/shared'

interface RoleRow {
  id: string
  slug: string
  display_name: string
  description: string | null
  idp_group: string | null
  managed_by_idp: number
  created_at: number
  updated_at: number
}

const SELECT_ROLE = `SELECT id, slug, display_name, description, idp_group,
  managed_by_idp, created_at, updated_at FROM roles`

export function toRoleRef(row: RoleRow): RoleRef {
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
    description: row.description
  }
}

export async function listRoles(env: Env): Promise<RoleRef[]> {
  const res = await env.DB.prepare(`${SELECT_ROLE} ORDER BY display_name`).all<RoleRow>()
  return (res.results ?? []).map(toRoleRef)
}

export async function listAdminRoles(env: Env): Promise<AdminRoleRow[]> {
  const res = await env.DB.prepare(
    `SELECT r.id, r.slug, r.display_name, r.description, r.idp_group,
            r.managed_by_idp, r.created_at, r.updated_at,
            (SELECT COUNT(*) FROM user_roles ur WHERE ur.role_id = r.id) AS member_count
     FROM roles r ORDER BY r.display_name`
  ).all<RoleRow & { member_count: number }>()
  return (res.results ?? []).map((row) => ({
    ...toRoleRef(row),
    idpGroup: row.idp_group,
    managedByIdp: row.managed_by_idp === 1,
    memberCount: row.member_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }))
}

export async function getRoleById(env: Env, id: string): Promise<RoleRow | null> {
  const row = await env.DB.prepare(`${SELECT_ROLE} WHERE id = ?1`).bind(id).first<RoleRow>()
  return row ?? null
}

export interface CreateRoleInput {
  slug: string
  displayName: string
  description?: string | null
  idpGroup?: string | null
  managedByIdp?: boolean
}

export async function createRole(env: Env, input: CreateRoleInput): Promise<RoleRow> {
  const id = newId()
  const now = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO roles (id, slug, display_name, description, idp_group, managed_by_idp,
       created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`
  )
    .bind(
      id,
      input.slug,
      input.displayName,
      input.description ?? null,
      input.idpGroup ?? null,
      input.managedByIdp ? 1 : 0,
      now
    )
    .run()
  const row = await getRoleById(env, id)
  if (!row) throw new Error('role_insert_lost')
  return row
}

export interface PatchRoleInput {
  slug?: string
  displayName?: string
  description?: string | null
  idpGroup?: string | null
  managedByIdp?: boolean
}

export async function patchRole(env: Env, id: string, patch: PatchRoleInput): Promise<void> {
  const fields: string[] = []
  const binds: unknown[] = []
  const push = (col: string, val: unknown) => {
    fields.push(`${col} = ?${fields.length + 1}`)
    binds.push(val)
  }
  if (patch.slug !== undefined) push('slug', patch.slug)
  if (patch.displayName !== undefined) push('display_name', patch.displayName)
  if (patch.description !== undefined) push('description', patch.description)
  if (patch.idpGroup !== undefined) push('idp_group', patch.idpGroup)
  if (patch.managedByIdp !== undefined) push('managed_by_idp', patch.managedByIdp ? 1 : 0)
  if (fields.length === 0) return
  fields.push(`updated_at = ?${fields.length + 1}`)
  binds.push(Math.floor(Date.now() / 1000))
  binds.push(id)
  await env.DB.prepare(`UPDATE roles SET ${fields.join(', ')} WHERE id = ?${binds.length}`)
    .bind(...binds)
    .run()
}

export async function deleteRole(env: Env, id: string): Promise<void> {
  // CASCADE removes user_roles rows. tool_access / upstream_visibility
  // rows that reference this role id by value are NOT cascaded (they
  // store a bare scope_id / principal_id, not an FK) — they simply stop
  // matching anyone, which is the safe "deny" direction.
  await env.DB.prepare(`DELETE FROM roles WHERE id = ?1`).bind(id).run()
}

// ----- user_roles --------------------------------------------------------

/** The role ids a user carries — powers ACL resolution + visibility. */
export async function listUserRoleIds(env: Env, userId: string): Promise<string[]> {
  const res = await env.DB.prepare(`SELECT role_id FROM user_roles WHERE user_id = ?1`)
    .bind(userId)
    .all<{ role_id: string }>()
  return (res.results ?? []).map((r) => r.role_id)
}

/** Replace a user's entire role set in one batch (DELETE + INSERTs). */
export async function setUserRoles(env: Env, userId: string, roleIds: string[]): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(`DELETE FROM user_roles WHERE user_id = ?1`).bind(userId)
  ]
  for (const roleId of roleIds) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO user_roles (user_id, role_id, created_at) VALUES (?1, ?2, ?3)
         ON CONFLICT (user_id, role_id) DO NOTHING`
      ).bind(userId, roleId, now)
    )
  }
  await env.DB.batch(stmts)
}

function newId(): string {
  return crypto.randomUUID().replace(/-/g, '')
}
