import { McpListSkillsResult, type McpSkillSummary } from '@ctxlayer/shared'
import { listAttachmentsForSkills } from '../../db/queries/skill-attachments'
import { listPublishedSkills } from '../../db/queries/skills'
import { listUpstreamsVisibleToUser } from '../../db/queries/upstreams'
import {
  draftedForUpstreams,
  missingUpstreams,
  requiredUpstreamSlugs,
  skillAccessAdvisory
} from '../../skills/skill-requires'
import { BUILTIN_INPUT_SHAPES } from '../builtin-schemas'
import { loadPublishedSkillMarkdown } from '../skill-render'
import { errText } from '../tool-result'
import { defineBuiltin } from './types'

// Both only ever surface `status='published'` skills; drafts and archived
// stay out of every MCP path.

/** `list_skills` — published org playbooks with their upstream requirements. */
export const listSkills = defineBuiltin({
  name: 'list_skills',
  // structuredContent must be an object, so the summary array is wrapped
  // under `skills`; the text `content` keeps the bare array for back-compat.
  outputShape: { skills: McpListSkillsResult },
  run: async (_args, { env, user }) => {
    const rows = await listPublishedSkills(env)
    // One IN-query for every skill's attachments instead of one
    // round trip per skill.
    const attachmentsBySkill = await listAttachmentsForSkills(
      env,
      rows.map((r) => r.id)
    )
    // The caller's reachable upstreams, fetched once, to flag per-skill
    // which required upstreams they can't currently reach.
    const userId = user?.userId
    const visible = userId
      ? new Set((await listUpstreamsVisibleToUser(env, userId)).map((u) => u.slug))
      : new Set<string>()
    // Typed against the shared MCP contract (`McpSkillSummary`).
    const summaries: McpSkillSummary[] = rows.map((row) => {
      const atts = attachmentsBySkill.get(row.id) ?? []
      const requires = requiredUpstreamSlugs(
        atts.map((a) => a.upstream_slug),
        draftedForUpstreams(row.drafter_meta)
      )
      return {
        slug: row.slug,
        name: row.slug,
        title: row.title,
        description: row.description,
        attached_to: atts.map((a) => ({
          upstream_slug: a.upstream_slug,
          tool_name: a.tool_name || null
        })),
        requires_upstreams: requires,
        missing_upstreams: missingUpstreams(requires, visible)
      }
    })
    return {
      content: [{ type: 'text', text: JSON.stringify(summaries, null, 2) }],
      structuredContent: { skills: summaries }
    }
  }
})

/** `get_skill` — one published skill's SKILL.md, plus an access advisory. */
export const getSkill = defineBuiltin({
  name: 'get_skill',
  inputShape: BUILTIN_INPUT_SHAPES.get_skill,
  run: async (args, { env, user }) => {
    const md = await loadPublishedSkillMarkdown(env, args.slug)
    if (md == null) return errText(`skill not found: ${args.slug}`)
    // Append an access advisory when the caller can't reach an upstream
    // this skill depends on, so the agent tells the user to connect it.
    const advisory = await skillAccessAdvisory(env, user?.userId, args.slug)
    return { content: [{ type: 'text', text: md + advisory }] }
  }
})
