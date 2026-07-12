/**
 * Assembles `SkillExportEntry`/`SkillExportResponse` — every published
 * skill (or a single one) with its body rendered to markdown. Consumed by
 * the web export endpoints (api/skills.ts): the bulk `.zip` download and
 * the per-skill `SKILL.md` download. Pair with `renderSkillMd` (skill-md.ts)
 * to turn an entry into the on-disk SKILL.md text.
 */

import type { SkillExportEntry, SkillExportResponse } from '@ctxlayer/shared'
import type { Env } from '../env'
import { listPublishedSkills } from '../db/queries/skills'
import { readSnapshot } from '../storage/skills-r2'
import { renderBlocksToMarkdown } from '../rag/markdown'

/** Minimal skill shape an export entry needs — satisfied by every row type
 *  that carries the identity + trigger columns (published rows, admin rows,
 *  the with-users row from getSkillById). */
export interface ExportableSkill {
  id: string
  slug: string
  description: string
  trigger_text: string
}

/** Render one skill row to an export entry (body pulled from its R2 snapshot). */
export async function buildSkillExportEntry(
  env: Env,
  row: ExportableSkill
): Promise<SkillExportEntry> {
  const snapshot = await readSnapshot(env, row.id)
  const bodyMd = snapshot ? renderBlocksToMarkdown(snapshot.blocks) : ''
  return {
    slug: row.slug,
    name: row.slug,
    description: row.description,
    triggerText: row.trigger_text,
    bodyMd
  }
}

export async function buildSkillExport(env: Env): Promise<SkillExportResponse> {
  const rows = await listPublishedSkills(env)
  const entries = await Promise.all(rows.map((row) => buildSkillExportEntry(env, row)))
  return { skills: entries }
}
