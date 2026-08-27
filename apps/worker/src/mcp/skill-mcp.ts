/**
 * MCP surface for skills: list_skills + get_skill tools plus a
 * `mcp://ctxlayer/skills/{slug}` resource template. Extracted from
 * session-do.ts to keep that file focused on session lifecycle.
 *
 * All three only ever surface `status='published'` skills; drafts and
 * archived stay admin-only via the SPA. Non-admin callers cannot reach
 * drafts through any MCP path.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Env } from '../env'
import { listPublishedSkills, type SkillWithUsersRow } from '../db/queries/skills'
import { listAttachmentsForSkills } from '../db/queries/skill-attachments'
import { type McpSkillSummary, McpListSkillsResult, builtinToolMeta } from '@ctxlayer/shared'
import { BUILTIN_INPUT_SHAPES } from './builtin-schemas'
import { loadPublishedSkillMarkdown } from './skill-render'
import { registerSkillSep2640 } from './skill-sep2640'
import { listUpstreamsVisibleToUser } from '../db/queries/upstreams'
import {
  draftedForUpstreams,
  missingUpstreams,
  requiredUpstreamSlugs,
  skillAccessAdvisory
} from '../skills/skill-requires'
import { errText } from './tool-result'
import { errMessage } from '../util/errors'

export type RecWrap = <T extends { content?: unknown; isError?: boolean }>(
  tool: string,
  args: unknown,
  exec: () => Promise<T>
) => Promise<T>

export function registerSkillMcp(
  server: McpServer,
  env: Env,
  rec: RecWrap,
  getUserId: () => string | undefined
): void {
  // list_skills + get_skill title/description are sourced from BUILTIN_TOOLS
  // in `packages/shared/src/builtin-tools.ts` via builtinToolMeta (single
  // source for /api/tools + the agent surface). Schemas + handlers stay here.
  server.registerTool(
    'list_skills',
    {
      ...builtinToolMeta('list_skills'),
      // structuredContent must be an object, so the summary array is wrapped
      // under `skills`; the text `content` keeps the bare array for back-compat.
      outputSchema: { skills: McpListSkillsResult }
    },
    () =>
      rec('list_skills', undefined, async () => {
        const rows = await listPublishedSkills(env)
        // One IN-query for every skill's attachments instead of one
        // round trip per skill.
        const attachmentsBySkill = await listAttachmentsForSkills(
          env,
          rows.map((r) => r.id)
        )
        // The caller's reachable upstreams, fetched once, to flag per-skill
        // which required upstreams they can't currently reach.
        const userId = getUserId()
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
      })
  )

  server.registerTool(
    'get_skill',
    { ...builtinToolMeta('get_skill'), inputSchema: BUILTIN_INPUT_SHAPES.get_skill },
    (args) =>
      rec('get_skill', args, async () => {
        const md = await loadPublishedSkillMarkdown(env, args.slug)
        if (md == null) return errText(`skill not found: ${args.slug}`)
        // Append an access advisory when the caller can't reach an upstream
        // this skill depends on, so the agent tells the user to connect it.
        const advisory = await skillAccessAdvisory(env, getUserId(), args.slug)
        return { content: [{ type: 'text', text: md + advisory }] }
      })
  )

  // mcp://ctxlayer/skills/{slug} — resource template enabling resource-
  // capable agents to discover and read skills without invoking a tool.
  const template = new ResourceTemplate('mcp://ctxlayer/skills/{slug}', {
    list: async () => {
      const rows = await listPublishedSkills(env)
      return {
        resources: rows.map((r) => ({
          uri: `mcp://ctxlayer/skills/${r.slug}`,
          name: r.title,
          description: r.description,
          mimeType: 'text/markdown'
        }))
      }
    }
  })

  server.registerResource(
    'skill',
    template,
    {
      title: 'Curated skills',
      description: 'Procedural playbooks the agent loads on demand.'
    },
    async (uri: URL, variables: { slug?: string | string[] }) => {
      const slugVar = variables.slug
      const slug = Array.isArray(slugVar) ? slugVar[0] : slugVar
      if (!slug) {
        return { contents: [{ uri: uri.toString(), text: 'missing skill slug' }] }
      }
      const md = await loadPublishedSkillMarkdown(env, slug)
      if (md == null) {
        return { contents: [{ uri: uri.toString(), text: `skill not found: ${slug}` }] }
      }
      return {
        contents: [{ uri: uri.toString(), mimeType: 'text/markdown', text: md }]
      }
    }
  )

  // Additive SEP-2640 future-proofing: serve the same skills over the
  // standard `skill://` scheme + a discovery document, and advertise the
  // skills extension capability. See skill-sep2640.ts.
  registerSkillSep2640(server, env)
}

// ----- prompt surface -----------------------------------------------------

/**
 * One MCP prompt per published org skill, named by slug — the
 * deliberate-invocation channel. The two resource surfaces above serve
 * agents that browse; prompts are what clients actually put in front of
 * HUMANS (the Claude Code slash list, Desktop's prompt picker), so a user
 * who knows a playbook exists can pull it in without memorising
 * `get_skill` slugs. Field-tested gap: resources are invisible in current
 * clients' UI.
 *
 * The prompt LIST is snapshotted at session init (same staleness contract
 * as the tool catalogue — a skill published mid-session appears on the
 * next connect). The prompt BODY is loaded fresh at invocation through
 * the same published+org gate as get_skill, so an unpublish between init
 * and invocation yields a notice, never stale or draft content.
 *
 * Never breaks session init: a failed list read registers nothing, and a
 * failed single registration (e.g. a grandfathered slug colliding with a
 * hand-registered prompt name) degrades that one prompt only.
 */
export async function registerSkillPrompts(
  server: McpServer,
  env: Env,
  getUserId: () => string | undefined
): Promise<void> {
  let rows: SkillWithUsersRow[]
  try {
    rows = await listPublishedSkills(env)
  } catch (err) {
    console.error(`[skill-prompts] list failed: ${errMessage(err)}`)
    return
  }
  for (const entry of skillPromptEntries(rows)) {
    try {
      server.registerPrompt(
        entry.name,
        { title: entry.title, description: entry.description },
        async () => {
          const md = await loadPublishedSkillMarkdown(env, entry.name)
          if (md == null) {
            return promptResult(`Skill ${entry.name} is no longer available.`)
          }
          const advisory = await skillAccessAdvisory(env, getUserId(), entry.name)
          return promptResult(
            `The user invoked the org playbook "${entry.title}". Apply it to the current task:\n\n${md}${advisory}`,
            entry.description
          )
        }
      )
    } catch (err) {
      console.error(`[skill-prompts] ${entry.name}: register failed: ${errMessage(err)}`)
    }
  }
}

/**
 * Prompt names owned by hand-registered prompts (session-do.ts). Skill
 * slugs are normally `sk-` prefixed, but grandfathered pre-convention
 * slugs can be anything — an unskipped collision would make the later
 * hand registration throw mid-init.
 */
const RESERVED_PROMPT_NAMES = new Set(['draft-skill'])

/** Pure assembly of the per-skill prompt registrations (exported for tests). */
export function skillPromptEntries(
  rows: Array<Pick<SkillWithUsersRow, 'slug' | 'title' | 'description'>>
): Array<{ name: string; title: string; description: string }> {
  return rows
    .filter((r) => !RESERVED_PROMPT_NAMES.has(r.slug))
    .map((r) => ({ name: r.slug, title: r.title, description: r.description }))
}

function promptResult(text: string, description?: string) {
  return {
    ...(description ? { description } : {}),
    messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }]
  }
}

// ----- helpers -----------------------------------------------------------

