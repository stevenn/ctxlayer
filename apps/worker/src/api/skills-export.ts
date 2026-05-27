/**
 * GET /api/skills/export — bulk export of all published skills for the
 * CLI's `ctxlayer pull` command. Each entry has everything the CLI
 * needs to materialise a SKILL.md file under
 * ~/.claude/skills/ctxlayer/<slug>/SKILL.md:
 *   - slug    → SKILL.md `name:` frontmatter (Claude Code identifier)
 *   - description → SKILL.md `description:` frontmatter
 *   - triggerText → appended as a paragraph at the top of the body
 *   - bodyMd  → markdown rendered from the BlockNote snapshot server-
 *               side so the CLI doesn't need a BlockNote renderer
 *
 * Open-read for any signed-in user (visibility is `status='published'`,
 * not per-caller). Snapshots are read in parallel; for ~100s of skills
 * R2 latency dominates so parallelism is meaningful.
 */

import { Hono } from 'hono'
import type { SkillExportEntry, SkillExportResponse } from '@ctxlayer/shared'
import type { Env } from '../env'
import { requireUser, type AuthedVariables } from '../auth/middleware'
import { listPublishedSkills } from '../db/queries/skills'
import { readSnapshot } from '../storage/skills-r2'
import { renderBlocksToMarkdown } from '../rag/markdown'

export const skillsExportRoute = new Hono<{ Bindings: Env; Variables: AuthedVariables }>()
skillsExportRoute.use('*', requireUser)

skillsExportRoute.get('/', async (c) => {
  const rows = await listPublishedSkills(c.env)
  const entries = await Promise.all(
    rows.map(async (row): Promise<SkillExportEntry> => {
      const snapshot = await readSnapshot(c.env, row.id)
      const bodyMd = snapshot ? renderBlocksToMarkdown(snapshot.blocks) : ''
      return {
        slug: row.slug,
        name: row.slug,
        description: row.description,
        triggerText: row.trigger_text,
        bodyMd
      }
    })
  )
  const body: SkillExportResponse = { skills: entries }
  return c.json(body)
})
