/**
 * Cheap, warning-only linter for skill bodies. Runs server-side on
 * POST /api/skills + POST /cli/skills + PUT /api/skills/:id/content +
 * the rendered markdown of the saved snapshot.
 *
 * Goal: catch obvious "this skill references a tool that doesn't
 * exist on its attached upstream" mistakes. Not a contract — findings
 * are warnings, never block save. Operators can intentionally
 * reference not-yet-cached tools (just refreshed, etc.) and we don't
 * want to frustrate them.
 *
 * Scope: only checks `<slug>__<tool>` mangled references where
 * `<slug>` matches an upstream slug attached to the skill. This
 * avoids false positives on unrelated text like `process__id` (which
 * happens to share the shape but isn't a tool reference).
 */

import type { Env } from '../env'
import { collapseSlugPrefix } from '@ctxlayer/shared'
import { listAttachmentsForSkill } from '../db/queries/skill-attachments'
import { listCachedTools } from '../db/queries/upstreams'
import { renderBlocksToMarkdown } from '../rag/markdown'

export interface LintFinding {
  kind: 'unknown_upstream' | 'unknown_tool'
  reference: string
  upstreamSlug: string | null
  toolName: string | null
}

/**
 * `bodyOrBlocks` accepts either pre-rendered markdown or the raw
 * BlockNote blocks (we'll render). Saves the caller a round-trip
 * when they already have the markdown.
 */
export async function lintSkillBody(
  env: Env,
  skillId: string,
  bodyOrBlocks: string | { blocks: unknown[] }
): Promise<LintFinding[]> {
  const text =
    typeof bodyOrBlocks === 'string'
      ? bodyOrBlocks
      : renderBlocksToMarkdown(bodyOrBlocks.blocks)

  // Pull attached upstream slugs once.
  const attachments = await listAttachmentsForSkill(env, skillId)
  if (attachments.length === 0) return []

  // attachedSlugs: slug → upstream_id (the slug matches the agent-
  // visible namespace; mangleToolName uses the SAME slug).
  const attachedByUpstreamSlug = new Map<string, string>()
  for (const a of attachments) attachedByUpstreamSlug.set(a.upstream_slug, a.upstream_id)

  // Pre-load cached tool lists for each attached upstream once. We
  // index the POST-COLLAPSE name only — that's what the agent-callable
  // mangled form (mangleToolName) puts after the `${slug}__` prefix.
  // Indexing the raw name as well would let `notion__notion-search`
  // pass the linter, but no such tool is registered with the MCP
  // server (it's registered as `notion__search` after collapse), so
  // the agent would fail to call it.
  const toolsBySlug = new Map<string, Set<string>>()
  await Promise.all(
    Array.from(attachedByUpstreamSlug.entries()).map(async ([slug, upstreamId]) => {
      const rows = await listCachedTools(env, upstreamId)
      const set = new Set<string>()
      for (const r of rows) set.add(collapseSlugPrefix(slug, r.tool_name))
      toolsBySlug.set(slug, set)
    })
  )

  const out: LintFinding[] = []
  const seen = new Set<string>()
  // Match `<slug>__<tool>` with conservative tool characters
  // (BlockNote inline code keeps `~` and `-` legal).
  for (const match of text.matchAll(/\b([a-z][a-z0-9_]*)__([a-zA-Z0-9_~-]+)\b/g)) {
    const slug = match[1]
    const toolName = match[2]
    if (!slug || !toolName) continue
    const ref = `${slug}__${toolName}`
    if (seen.has(ref)) continue
    seen.add(ref)
    // Only flag references whose slug matches an attached upstream
    // — otherwise the regex is too loose.
    if (!attachedByUpstreamSlug.has(slug)) continue
    const tools = toolsBySlug.get(slug)
    if (!tools) {
      out.push({
        kind: 'unknown_upstream',
        reference: ref,
        upstreamSlug: slug,
        toolName: null
      })
      continue
    }
    // Match the post-collapse name (what mangleToolName produces).
    // Strip the `_~_` escape so `foo_~_bar` reads as `foo__bar` when
    // comparing against raw upstream tool names.
    const candidate = toolName.replaceAll('_~_', '__')
    if (!tools.has(candidate)) {
      out.push({
        kind: 'unknown_tool',
        reference: ref,
        upstreamSlug: slug,
        toolName: candidate
      })
    }
  }
  return out
}
