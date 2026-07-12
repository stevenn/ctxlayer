/**
 * Skill read helper for the agent-facing MCP surface. Lives apart from
 * skill-mcp.ts so both the canonical surface (list_skills/get_skill +
 * `mcp://ctxlayer/skills/{slug}`) and the SEP-2640 `skill://` surface can
 * import it without a circular dependency. SKILL.md text comes from the
 * shared renderer in skills/skill-md.ts.
 */

import type { Env } from '../env'
import { getSkillBySlug } from '../db/queries/skills'
import { readSnapshot } from '../storage/skills-r2'
import { renderBlocksToMarkdown } from '../rag/markdown'
import { renderSkillMd } from '../skills/skill-md'

/**
 * Load an org-shared published skill's rendered SKILL.md markdown by
 * slug, or null if the slug is unknown / not org-shared+published.
 * Single-sourced read shared by get_skill and both resource surfaces
 * (mcp:// and skill://) so the visibility gate and rendering never drift
 * between them. Private skills never surface here — owner-scoped MCP
 * access (draft-and-test) threads a caller id in a later phase.
 */
export async function loadPublishedSkillMarkdown(env: Env, slug: string): Promise<string | null> {
  const row = await getSkillBySlug(env, slug)
  if (!row || row.status !== 'published' || row.visibility !== 'org') return null
  const content = await readSnapshot(env, row.id)
  const body = content ? renderBlocksToMarkdown(content.blocks) : ''
  // Agent-facing (no provenance comment); shared renderer keeps the shape
  // identical to the web SKILL.md download.
  return renderSkillMd(
    { slug: row.slug, name: row.slug, description: row.description, triggerText: row.trigger_text, bodyMd: body },
    {}
  )
}
