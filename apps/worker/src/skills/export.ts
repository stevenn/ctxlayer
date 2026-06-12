/**
 * Assembles the `SkillExportResponse` for `ctxlayer pull`: every
 * published skill with its body rendered to markdown. Shared by the
 * bearer-gated CLI handler (`cli-export-handler.ts`); the response
 * shape is a live CLI contract — keep it byte-identical.
 */

import type { SkillExportEntry, SkillExportResponse } from '@ctxlayer/shared'
import type { Env } from '../env'
import { listPublishedSkills } from '../db/queries/skills'
import { readSnapshot } from '../storage/skills-r2'
import { renderBlocksToMarkdown } from '../rag/markdown'

export async function buildSkillExport(env: Env): Promise<SkillExportResponse> {
  const rows = await listPublishedSkills(env)
  const entries = await Promise.all(
    rows.map(async (row): Promise<SkillExportEntry> => {
      const snapshot = await readSnapshot(env, row.id)
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
  return { skills: entries }
}
