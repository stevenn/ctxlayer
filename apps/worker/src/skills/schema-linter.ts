/**
 * Cheap, warning-only linter for skill bodies. Runs server-side on
 * skill create/save (REST + the MCP `save_draft_skill` path) over the
 * rendered markdown of the saved snapshot.
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
 *
 * Findings (all warning-only, never block save):
 *   - `unknown_upstream` — slug is attached but has no cached catalogue.
 *   - `unknown_tool` — slug matches but the tool isn't in the cache
 *     (typo / stale catalogue).
 *   - `mangled_reference` — a VALID `<slug>__<tool>` ref. Discouraged:
 *     it bakes this install's slug into the body, so the skill breaks
 *     if the upstream is re-registered under a different slug or reused
 *     on another install. `toolName` carries the NATIVE name the body
 *     should use instead. The drafter prompt (v3+) emits native names;
 *     this flags pre-v3 / hand-authored bodies for migration.
 */

import type { Env } from '../env'
import { collapseSlugPrefix, extractMangledRefs } from '@ctxlayer/shared'
import { listAttachmentsForSkill } from '../db/queries/skill-attachments'
import { listCachedTools } from '../db/queries/upstream-tools'
import { renderBlocksToMarkdown } from '../rag/markdown'

export interface LintFinding {
  kind: 'unknown_upstream' | 'unknown_tool' | 'mangled_reference'
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
    typeof bodyOrBlocks === 'string' ? bodyOrBlocks : renderBlocksToMarkdown(bodyOrBlocks.blocks)

  // Pull attached upstream slugs once.
  const attachments = await listAttachmentsForSkill(env, skillId)
  if (attachments.length === 0) return []

  // attachedSlugs: slug → upstream_id (the slug matches the agent-
  // visible namespace; mangleToolName uses the SAME slug).
  const attachedByUpstreamSlug = new Map<string, string>()
  for (const a of attachments) attachedByUpstreamSlug.set(a.upstream_slug, a.upstream_id)

  // Pre-load cached tool lists for each attached upstream once. We key
  // by the POST-COLLAPSE name — that's what the agent-callable mangled
  // form (mangleToolName) puts after the `${slug}__` prefix — and map it
  // to the RAW upstream tool name. Keying on collapse (not raw) means
  // `notion__notion-search` won't pass (only `notion__search` is
  // registered with the MCP server); the raw value is the native name a
  // portable body should use, surfaced via `mangled_reference`.
  const toolsBySlug = new Map<string, Map<string, string>>()
  await Promise.all(
    Array.from(attachedByUpstreamSlug.entries()).map(async ([slug, upstreamId]) => {
      const rows = await listCachedTools(env, upstreamId)
      const byCallable = new Map<string, string>()
      for (const r of rows) byCallable.set(collapseSlugPrefix(slug, r.tool_name), r.tool_name)
      toolsBySlug.set(slug, byCallable)
    })
  )

  const out: LintFinding[] = []
  // `extractMangledRefs` owns the `<slug>__<tool>` regex + first-seen
  // dedup, shared with the upstream-dependency calculator so the pattern
  // can't drift. It's intentionally loose; we narrow to attached slugs.
  for (const { slug, toolName } of extractMangledRefs(text)) {
    const ref = `${slug}__${toolName}`
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
    const nativeName = tools.get(candidate)
    if (nativeName === undefined) {
      out.push({
        kind: 'unknown_tool',
        reference: ref,
        upstreamSlug: slug,
        toolName: candidate
      })
      continue
    }
    // Valid mangled reference — discouraged. Surface the NATIVE name the
    // body should switch to (portable across re-registration / installs).
    out.push({
      kind: 'mangled_reference',
      reference: ref,
      upstreamSlug: slug,
      toolName: nativeName
    })
  }
  return out
}
