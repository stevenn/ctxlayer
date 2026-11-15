/**
 * MCP resources + prompts for skills: the `mcp://ctxlayer/skills/{slug}`
 * resource template, the SEP-2640 skill resources, and one prompt per
 * published skill. (The `list_skills` / `get_skill` TOOLS are lane-neutral
 * built-ins in `mcp/builtins/skills.ts`.)
 *
 * Everything here only ever surfaces `status='published'` skills; drafts and
 * archived stay out of every MCP path.
 */

import type { Env } from '../env'
import { listPublishedSkills, type SkillWithUsersRow } from '../db/queries/skills'
import { loadPublishedSkillMarkdown } from './skill-render'
import { registerSkillSep2640 } from './skill-sep2640'
import { skillAccessAdvisory } from '../skills/skill-requires'
import { errMessage } from '../util/errors'
import { firstVar, type McpSurface } from './surface'

export function registerSkillResources(surface: McpSurface, env: Env): void {
  // mcp://ctxlayer/skills/{slug} — resource template enabling resource-
  // capable agents to discover and read skills without invoking a tool.
  const template = surface.resourceTemplate('mcp://ctxlayer/skills/{slug}', async () => {
    const rows = await listPublishedSkills(env)
    return {
      resources: rows.map((r) => ({
        uri: `mcp://ctxlayer/skills/${r.slug}`,
        name: r.title,
        description: r.description,
        mimeType: 'text/markdown'
      }))
    }
  })

  surface.registerResource(
    'skill',
    template,
    {
      title: 'Curated skills',
      description: 'Procedural playbooks the agent loads on demand.'
    },
    async (uri, variables) => {
      const slug = firstVar(variables.slug)
      if (!slug) return { contents: [{ uri: uri.toString(), text: 'missing skill slug' }] }
      const md = await loadPublishedSkillMarkdown(env, slug)
      if (md == null) {
        return { contents: [{ uri: uri.toString(), text: `skill not found: ${slug}` }] }
      }
      return { contents: [{ uri: uri.toString(), mimeType: 'text/markdown', text: md }] }
    }
  )

  // Additive SEP-2640 future-proofing: serve the same skills over the
  // standard `skill://` scheme + a discovery document, and advertise the
  // skills extension capability. See skill-sep2640.ts.
  registerSkillSep2640(surface, env)
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
 * On the session lane the prompt LIST is snapshotted at session init (same
 * staleness contract as the tool catalogue — a skill published mid-session
 * appears on the next connect); the stateless lane rebuilds it per request. The prompt BODY is loaded fresh at invocation through
 * the same published+org gate as get_skill, so an unpublish between init
 * and invocation yields a notice, never stale or draft content.
 *
 * Never breaks session init: a failed list read registers nothing, and a
 * failed single registration (e.g. a grandfathered slug colliding with a
 * hand-registered prompt name) degrades that one prompt only.
 */
export async function registerSkillPrompts(
  surface: McpSurface,
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
      surface.registerPrompt(
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
 * Prompt names owned by hand-registered prompts (draft-skill-prompt.ts). Skill
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

