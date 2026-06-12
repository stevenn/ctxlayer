/**
 * Skill ↔ upstream(.tool) attachment management. Admin-only mutations;
 * reads are open (any signed-in user can see what's attached).
 */

import { Hono } from 'hono'
import { AttachSkillRequest } from '@ctxlayer/shared'
import type { Env } from '../env'
import { requireAdmin, requireUser, type AuthedVariables } from '../auth/middleware'
import { requireCsrf } from '../auth/csrf'
import { attachSkill, detachSkill, listAttachmentsForSkill } from '../db/queries/skill-attachments'
import { getSkillById } from '../db/queries/skills'
import { getUpstreamById } from '../db/queries/upstreams'
import { audit } from '../audit/log'
import { notFound, parseJsonBody } from './respond'

export const skillAttachmentsRoute = new Hono<{ Bindings: Env; Variables: AuthedVariables }>()
skillAttachmentsRoute.use('*', requireUser)
skillAttachmentsRoute.use('*', requireCsrf)

skillAttachmentsRoute.get('/', async (c) => {
  const skillId = c.req.query('skillId')
  if (!skillId) return c.json({ error: 'missing_skill_id' }, 400)
  const skill = await getSkillById(c.env, skillId)
  if (!skill) return notFound(c)
  if (c.get('user').role !== 'admin' && skill.status !== 'published')
    return notFound(c)
  const rows = await listAttachmentsForSkill(c.env, skillId)
  return c.json(
    rows.map((r) => ({
      upstreamId: r.upstream_id,
      upstreamSlug: r.upstream_slug,
      toolName: r.tool_name
    }))
  )
})

skillAttachmentsRoute.post('/', requireAdmin, async (c) => {
  const parsed = await parseJsonBody(c, AttachSkillRequest)
  if (!parsed.ok) return parsed.res
  const { skillId, upstreamId, toolName } = parsed.data
  // Both sides must exist; we don't leak which is missing in production
  // (single 'not_found' code).
  const [skill, upstream] = await Promise.all([
    getSkillById(c.env, skillId),
    getUpstreamById(c.env, upstreamId)
  ])
  if (!skill || !upstream) return notFound(c)
  const actor = c.get('user')
  await attachSkill(c.env, { skillId, upstreamId, toolName, createdBy: actor.userId })
  await audit(c.env, {
    actorId: actor.userId,
    action: 'skill.attach',
    target: skillId,
    meta: { upstreamId, toolName: toolName ?? '' }
  })
  return new Response(null, { status: 204 })
})

skillAttachmentsRoute.delete('/', requireAdmin, async (c) => {
  const parsed = await parseJsonBody(c, AttachSkillRequest)
  if (!parsed.ok) return parsed.res
  const { skillId, upstreamId, toolName } = parsed.data
  await detachSkill(c.env, { skillId, upstreamId, toolName })
  await audit(c.env, {
    actorId: c.get('user').userId,
    action: 'skill.detach',
    target: skillId,
    meta: { upstreamId, toolName: toolName ?? '' }
  })
  return new Response(null, { status: 204 })
})
