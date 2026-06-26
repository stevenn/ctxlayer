/**
 * Shared skill → SKILL.md rendering + read helpers. Lives apart from
 * skill-mcp.ts so both the canonical surface (list_skills/get_skill +
 * `mcp://ctxlayer/skills/{slug}`) and the SEP-2640 `skill://` surface can
 * import it without a circular dependency.
 */

import type { Env } from '../env'
import { getSkillBySlug } from '../db/queries/skills'
import { readSnapshot } from '../storage/skills-r2'
import { renderBlocksToMarkdown } from '../rag/markdown'

/**
 * Render the SKILL.md envelope an agent expects: YAML frontmatter
 * (name + description) + optional trigger paragraph + body.
 * Matches what the CLI's `ctxlayer pull` writes to disk so MCP and
 * filesystem agents see the same shape.
 */
export function renderSkillMd(
  slug: string,
  description: string,
  trigger: string,
  body: string
): string {
  const fm = `---\nname: ${slug}\ndescription: ${yamlOneLine(description)}\n---\n`
  const triggerPart = trigger.trim() ? `\n${trigger.trim()}\n` : ''
  return `${fm}${triggerPart}\n${body || '_empty skill_'}`
}

function yamlOneLine(s: string): string {
  // Quote if the value contains characters that would confuse YAML's
  // simple-scalar parser. Cheap heuristic; full YAML quoting is overkill
  // for a description string.
  if (/[:#\n"\\]/.test(s)) return JSON.stringify(s)
  return s
}

/**
 * Load a published skill's rendered SKILL.md markdown by slug, or null if
 * the slug is unknown / not published. Single-sourced read shared by
 * get_skill and both resource surfaces (mcp:// and skill://) so the
 * status gate and rendering never drift between them.
 */
export async function loadPublishedSkillMarkdown(env: Env, slug: string): Promise<string | null> {
  const row = await getSkillBySlug(env, slug)
  if (!row || row.status !== 'published') return null
  const content = await readSnapshot(env, row.id)
  const body = content ? renderBlocksToMarkdown(content.blocks) : ''
  return renderSkillMd(row.slug, row.description, row.trigger_text, body)
}
