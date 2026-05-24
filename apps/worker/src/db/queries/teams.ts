/**
 * D1 queries for `teams` and `team_members`. The /api/teams reader
 * is signed-in only; CRUD + member management is gated to admins at
 * the route layer.
 */

import type { Env } from '../../env'
import type { TeamRef, TeamMemberRow as TeamMemberShape } from '@ctxlayer/shared'

interface TeamRow {
  id: string
  slug: string
  display_name: string
  description: string | null
  idp_group: string | null
  created_at: number
  updated_at: number
}

export function toTeamRef(row: TeamRow): TeamRef {
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
    description: row.description
  }
}

export async function listTeams(env: Env): Promise<TeamRef[]> {
  const res = await env.DB.prepare(
    `SELECT id, slug, display_name, description, idp_group, created_at, updated_at
     FROM teams ORDER BY display_name`
  ).all<TeamRow>()
  return (res.results ?? []).map(toTeamRef)
}

export async function getTeamById(env: Env, id: string): Promise<TeamRow | null> {
  const row = await env.DB.prepare(
    `SELECT id, slug, display_name, description, idp_group, created_at, updated_at
     FROM teams WHERE id = ?1`
  )
    .bind(id)
    .first<TeamRow>()
  return row ?? null
}

export interface CreateTeamInput {
  slug: string
  displayName: string
  description?: string | null
  idpGroup?: string | null
}

export async function createTeam(env: Env, input: CreateTeamInput): Promise<TeamRow> {
  const id = newId()
  const now = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO teams (id, slug, display_name, description, idp_group, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`
  )
    .bind(id, input.slug, input.displayName, input.description ?? null, input.idpGroup ?? null, now)
    .run()
  const row = await getTeamById(env, id)
  if (!row) throw new Error('team_insert_lost')
  return row
}

export interface PatchTeamInput {
  slug?: string
  displayName?: string
  description?: string | null
  idpGroup?: string | null
}

export async function patchTeam(env: Env, id: string, patch: PatchTeamInput): Promise<void> {
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
  if (patch.idpGroup !== undefined) {
    fields.push(`idp_group = ?${fields.length + 1}`)
    binds.push(patch.idpGroup)
  }
  if (fields.length === 0) return
  fields.push(`updated_at = ?${fields.length + 1}`)
  binds.push(Math.floor(Date.now() / 1000))
  binds.push(id)
  await env.DB.prepare(`UPDATE teams SET ${fields.join(', ')} WHERE id = ?${binds.length}`)
    .bind(...binds)
    .run()
}

export async function deleteTeam(env: Env, id: string): Promise<void> {
  // CASCADE in 0004_org_ia.sql removes team_members and team_products rows.
  await env.DB.prepare(`DELETE FROM teams WHERE id = ?1`).bind(id).run()
}

// ----- members -----------------------------------------------------------

interface MemberJoinRow {
  user_id: string
  email: string
  name: string | null
  role: 'member' | 'lead'
  created_at: number
}

export async function listTeamMembers(env: Env, teamId: string): Promise<TeamMemberShape[]> {
  const res = await env.DB.prepare(
    `SELECT tm.user_id, u.email, u.name, tm.role, tm.created_at
     FROM team_members tm
     JOIN users u ON u.id = tm.user_id
     WHERE tm.team_id = ?1
     ORDER BY tm.role DESC, u.email`
  )
    .bind(teamId)
    .all<MemberJoinRow>()
  return (res.results ?? []).map((r) => ({
    userId: r.user_id,
    email: r.email,
    name: r.name,
    role: r.role,
    createdAt: r.created_at
  }))
}

export async function addTeamMember(
  env: Env,
  teamId: string,
  userId: string,
  role: 'member' | 'lead' = 'member'
): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO team_members (team_id, user_id, role, created_at)
     VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (team_id, user_id) DO UPDATE SET role = excluded.role`
  )
    .bind(teamId, userId, role, now)
    .run()
}

export async function removeTeamMember(
  env: Env,
  teamId: string,
  userId: string
): Promise<void> {
  await env.DB.prepare(`DELETE FROM team_members WHERE team_id = ?1 AND user_id = ?2`)
    .bind(teamId, userId)
    .run()
}

function newId(): string {
  return crypto.randomUUID().replace(/-/g, '')
}
