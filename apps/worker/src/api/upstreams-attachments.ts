/**
 * Shared attachment-grouping helper for the per-tool catalogue endpoints
 * in upstreams.ts (user-facing) and admin-upstreams.ts (admin-facing).
 * Takes the flat skill+doc attachment lists for an upstream and groups
 * them into:
 *   - whole.{skills,docs}         (rows with tool_name = '')
 *   - byTool.get('foo').{skills,docs}  (rows scoped to a tool)
 *
 * Kept in its own file so both route files share the same grouping
 * logic without circular imports.
 */

import type { SkillForUpstreamRow } from '../db/queries/skill-attachments'
import type { DocForUpstreamRow } from '../db/queries/doc-attachments'

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
