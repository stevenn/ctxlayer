/**
 * D1 queries for skill ↔ upstream(.tool) attachments. Mirrors
 * doc-attachments.ts. Attachments are admin-managed; reads are open
 * (any signed-in user can see what's attached to which upstream).
 */

import type { Env } from '../../env'

export interface SkillAttachmentRow {
  skill_id: string
  upstream_id: string
  upstream_slug: string
  tool_name: string
}

/**
 * Attachments for one skill, joined to the upstream slug. Excludes
 * attachments whose upstream was soft-deleted.
 */
export async function listAttachmentsForSkill(
  env: Env,
  skillId: string
): Promise<SkillAttachmentRow[]> {
  const res = await env.DB.prepare(
    `SELECT sa.skill_id, sa.upstream_id, sa.tool_name,
            u.slug AS upstream_slug
     FROM skill_attachments sa
     JOIN upstream_servers u ON u.id = sa.upstream_id
     WHERE sa.skill_id = ?1
     ORDER BY u.slug, sa.tool_name`
  )
    .bind(skillId)
    .all<SkillAttachmentRow>()
  return res.results ?? []
}

export interface SkillForUpstreamRow {
  skill_id: string
  slug: string
  title: string
  tool_name: string
  status: 'draft' | 'published' | 'archived'
}

/**
 * Attachments for one upstream, joined to the skill summary. `includeDrafts`
 * lets the admin SPA see drafts in the upstream detail page; non-admin
 * callers should always pass false so MCP `list_upstreams` only shows
 * published skills.
 */
export async function listSkillsForUpstream(
  env: Env,
  upstreamId: string,
  opts: { includeDrafts?: boolean } = {}
): Promise<SkillForUpstreamRow[]> {
  const whereStatus = opts.includeDrafts
    ? `(s.status = 'draft' OR s.status = 'published')`
    : `s.status = 'published'`
  const res = await env.DB.prepare(
    `SELECT sa.skill_id, s.slug, s.title, sa.tool_name, s.status
     FROM skill_attachments sa
     JOIN skills s ON s.id = sa.skill_id
     WHERE sa.upstream_id = ?1
       AND s.deleted_at IS NULL
       AND ${whereStatus}
     ORDER BY sa.tool_name, s.title`
  )
    .bind(upstreamId)
    .all<SkillForUpstreamRow>()
  return res.results ?? []
}

/**
 * Batch variant of `listAttachmentsForSkill`: one `IN (...)` query for
 * many skills, grouped by skill_id. Within each skill the rows keep the
 * same (upstream slug, tool_name) order as the single-id query. Powers
 * the MCP `list_skills` surface without an N+1.
 */
export async function listAttachmentsForSkills(
  env: Env,
  skillIds: string[]
): Promise<Map<string, SkillAttachmentRow[]>> {
  const out = new Map<string, SkillAttachmentRow[]>()
  if (skillIds.length === 0) return out
  const placeholders = skillIds.map((_, i) => `?${i + 1}`).join(', ')
  const res = await env.DB.prepare(
    `SELECT sa.skill_id, sa.upstream_id, sa.tool_name,
            u.slug AS upstream_slug
     FROM skill_attachments sa
     JOIN upstream_servers u ON u.id = sa.upstream_id
     WHERE sa.skill_id IN (${placeholders})
     ORDER BY u.slug, sa.tool_name`
  )
    .bind(...skillIds)
    .all<SkillAttachmentRow>()
  for (const row of res.results ?? []) {
    const arr = out.get(row.skill_id)
    if (arr) arr.push(row)
    else out.set(row.skill_id, [row])
  }
  return out
}

/**
 * Batch variant of `listSkillsForUpstream` (published-only — MCP surfaces
 * never see drafts): one `IN (...)` query for many upstreams, grouped by
 * upstream_id. Within each upstream the rows keep the single-id query's
 * (tool_name, title) order.
 */
export async function listSkillsForUpstreams(
  env: Env,
  upstreamIds: string[]
): Promise<Map<string, SkillForUpstreamRow[]>> {
  const out = new Map<string, SkillForUpstreamRow[]>()
  if (upstreamIds.length === 0) return out
  const placeholders = upstreamIds.map((_, i) => `?${i + 1}`).join(', ')
  const res = await env.DB.prepare(
    `SELECT sa.upstream_id, sa.skill_id, s.slug, s.title, sa.tool_name, s.status
     FROM skill_attachments sa
     JOIN skills s ON s.id = sa.skill_id
     WHERE sa.upstream_id IN (${placeholders})
       AND s.deleted_at IS NULL
       AND s.status = 'published'
     ORDER BY sa.tool_name, s.title`
  )
    .bind(...upstreamIds)
    .all<SkillForUpstreamRow & { upstream_id: string }>()
  for (const row of res.results ?? []) {
    const arr = out.get(row.upstream_id)
    if (arr) arr.push(row)
    else out.set(row.upstream_id, [row])
  }
  return out
}

export interface AttachSkillInput {
  skillId: string
  upstreamId: string
  toolName?: string
  createdBy: string
}

/**
 * Idempotent attach. Re-attaching the same (skill, upstream, tool)
 * tuple is a no-op (INSERT OR IGNORE). tool_name defaults to '' for
 * whole-upstream attachment.
 */
export async function attachSkill(env: Env, input: AttachSkillInput): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT OR IGNORE INTO skill_attachments
       (skill_id, upstream_id, tool_name, created_at, created_by)
     VALUES (?1, ?2, ?3, ?4, ?5)`
  )
    .bind(input.skillId, input.upstreamId, input.toolName ?? '', now, input.createdBy)
    .run()
}

export async function detachSkill(
  env: Env,
  input: { skillId: string; upstreamId: string; toolName?: string }
): Promise<void> {
  await env.DB.prepare(
    `DELETE FROM skill_attachments
     WHERE skill_id = ?1 AND upstream_id = ?2 AND tool_name = ?3`
  )
    .bind(input.skillId, input.upstreamId, input.toolName ?? '')
    .run()
}
