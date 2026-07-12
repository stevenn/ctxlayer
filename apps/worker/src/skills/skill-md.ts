/**
 * Single source for SKILL.md rendering: YAML frontmatter (`name` +
 * `description`) followed by the optional trigger hints and the markdown
 * body. Two consumers share it so the shape never drifts:
 *   - the MCP `get_skill` / `skill://` surface (mcp/skill-render.ts) —
 *     agent-facing string, no provenance comment;
 *   - the web export endpoints (api/skills.ts) — an on-disk `SKILL.md`
 *     file, so a provenance comment + forced LF line endings.
 * Output with default opts is byte-identical to what the retired
 * `ctxlayer pull` CLI used to write.
 */

import type { SkillExportEntry } from '@ctxlayer/shared'

export interface RenderSkillMdOpts {
  /** Emit a `<!-- Exported from ctxlayer. -->` line after the frontmatter.
   *  On for file downloads; off for the agent-facing MCP surface. */
  provenance?: boolean
  /** Normalise to LF line endings — for on-disk SKILL.md files (Claude Code
   *  expects LF; Windows Git would otherwise smear CRLF on next checkout). */
  forceLf?: boolean
}

export function renderSkillMd(entry: SkillExportEntry, opts: RenderSkillMdOpts = {}): string {
  const fm =
    `---\n` + `name: ${entry.name}\n` + `description: ${yamlOneLine(entry.description)}\n` + `---\n`
  const provenance = opts.provenance ? `<!-- Exported from ctxlayer. -->\n` : ''
  const triggerPart = entry.triggerText.trim() ? `\n${entry.triggerText.trim()}\n` : ''
  const body = entry.bodyMd || '_empty skill_'
  const out = `${fm}${provenance}${triggerPart}\n${body}`
  return opts.forceLf ? out.replace(/\r\n/g, '\n') : out
}

function yamlOneLine(s: string): string {
  // Quote if the value contains chars that would confuse YAML's
  // simple-scalar parser. Cheap heuristic; full YAML quoting is
  // overkill for a description string.
  if (/[:#\n"\\]/.test(s)) return JSON.stringify(s)
  return s
}
