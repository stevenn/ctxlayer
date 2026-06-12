/**
 * Shared helpers for the per-tool catalogue endpoints in upstreams.ts
 * (user-facing) and admin-upstreams.ts (admin-facing):
 *   - `groupAttachmentsForTools` groups the flat skill+doc attachment
 *     lists into whole-upstream vs per-tool buckets;
 *   - `buildUpstreamToolsPayload` assembles the full
 *     `{ upstreamId, slug, attachedSkills, attachedDocs, tools }`
 *     response both routes return (only includeDrafts differs).
 *
 * Kept in its own file so both route files share the same logic
 * without circular imports.
 */

import type { Env } from '../env'
import { listCachedTools } from '../db/queries/upstreams'
import { listSkillsForUpstream, type SkillForUpstreamRow } from '../db/queries/skill-attachments'
import { listDocsForUpstream, type DocForUpstreamRow } from '../db/queries/doc-attachments'

export interface AttachmentChips {
  skills: Array<{ slug: string; title: string }>
  docs: Array<{ slug: string; title: string }>
}

export interface AttachmentBundle {
  whole: AttachmentChips
  byTool: Map<string, AttachmentChips>
}

export function groupAttachmentsForTools(
  skillRows: SkillForUpstreamRow[],
  docRows: DocForUpstreamRow[]
): AttachmentBundle {
  const whole: AttachmentChips = { skills: [], docs: [] }
  const byTool = new Map<string, AttachmentChips>()
  const bucketFor = (tool: string): AttachmentChips => {
    if (!byTool.has(tool)) byTool.set(tool, { skills: [], docs: [] })
    return byTool.get(tool)!
  }
  for (const s of skillRows) {
    const entry = { slug: s.slug, title: s.title }
    if (s.tool_name === '') whole.skills.push(entry)
    else bucketFor(s.tool_name).skills.push(entry)
  }
  for (const d of docRows) {
    const entry = { slug: d.slug, title: d.title }
    if (d.tool_name === '') whole.docs.push(entry)
    else bucketFor(d.tool_name).docs.push(entry)
  }
  return { whole, byTool }
}

/**
 * The cached tool catalogue + attachments for one upstream, in the JSON
 * shape both the user and admin tools endpoints return. The admin view
 * passes `includeDrafts: true` to see draft skills as well.
 */
export async function buildUpstreamToolsPayload(
  env: Env,
  upstream: { id: string; slug: string },
  opts: { includeDrafts?: boolean } = {}
) {
  const [tools, skillAtt, docAtt] = await Promise.all([
    listCachedTools(env, upstream.id),
    listSkillsForUpstream(env, upstream.id, opts),
    listDocsForUpstream(env, upstream.id)
  ])
  const bundle = groupAttachmentsForTools(skillAtt, docAtt)
  return {
    upstreamId: upstream.id,
    slug: upstream.slug,
    attachedSkills: bundle.whole.skills,
    attachedDocs: bundle.whole.docs,
    tools: tools.map((t) => ({
      toolName: t.tool_name,
      description: t.description,
      inputSchema: safeParseJson(t.input_schema),
      cachedAt: t.cached_at,
      lastSchemaChangeAt: t.last_schema_change_at,
      lastDiffSummary: t.last_diff_summary,
      attachedSkills: bundle.byTool.get(t.tool_name)?.skills ?? [],
      attachedDocs: bundle.byTool.get(t.tool_name)?.docs ?? []
    }))
  }
}

function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return s
  }
}
