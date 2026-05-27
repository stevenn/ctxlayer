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
import { z } from 'zod'
import type { Env } from '../env'
import { getSkillBySlug, listPublishedSkills } from '../db/queries/skills'
import { listAttachmentsForSkill } from '../db/queries/skill-attachments'
import { readSnapshot } from '../storage/skills-r2'
import { renderBlocksToMarkdown } from '../rag/markdown'

export type RecWrap = <T extends { content?: unknown; isError?: boolean }>(
  tool: string,
  args: unknown,
  exec: () => Promise<T>
) => Promise<T>

export function registerSkillMcp(server: McpServer, env: Env, rec: RecWrap): void {
  server.registerTool(
    'list_skills',
    {
      title: 'List skills',
      description:
        'Lists org-curated skills (procedural playbooks the agent can load on demand). Each entry carries the SKILL.md `name`, a one-line `description` (when to invoke), and the upstream tools it is attached to. Only published skills surface.'
    },
    () =>
      rec('list_skills', undefined, async () => {
        const rows = await listPublishedSkills(env)
        const summaries = await Promise.all(
          rows.map(async (row) => {
            const attachments = await listAttachmentsForSkill(env, row.id)
            return {
              slug: row.slug,
              name: row.slug,
              title: row.title,
              description: row.description,
              attached_to: attachments.map((a) => ({
                upstream_slug: a.upstream_slug,
                tool_name: a.tool_name || null
              }))
            }
          })
        )
        return {
          content: [{ type: 'text', text: JSON.stringify(summaries, null, 2) }]
        }
      })
  )

  server.registerTool(
    'get_skill',
    {
      title: 'Get skill',
      description:
        'Fetches a skill body by slug. Returns SKILL.md frontmatter + body in markdown.',
      inputSchema: { slug: z.string().min(1) }
    },
    (args) =>
      rec('get_skill', args, async () => {
        const { slug } = args
        const row = await getSkillBySlug(env, slug)
        if (!row || row.status !== 'published') return errText(`skill not found: ${slug}`)
        const content = await readSnapshot(env, row.id)
        const body = content ? renderBlocksToMarkdown(content.blocks) : ''
        return {
          content: [
            { type: 'text', text: renderSkillMd(row.slug, row.description, row.trigger_text, body) }
          ]
        }
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
      const row = await getSkillBySlug(env, slug)
      if (!row || row.status !== 'published') {
        return { contents: [{ uri: uri.toString(), text: `skill not found: ${slug}` }] }
      }
      const content = await readSnapshot(env, row.id)
      const body = content ? renderBlocksToMarkdown(content.blocks) : ''
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: 'text/markdown',
            text: renderSkillMd(row.slug, row.description, row.trigger_text, body)
          }
        ]
      }
    }
  )
}

// ----- helpers -----------------------------------------------------------

/**
 * Render the SKILL.md envelope an agent expects: YAML frontmatter
 * (name + description) + optional trigger paragraph + body.
 * Matches what the CLI's `ctxlayer pull` writes to disk so MCP and
 * filesystem agents see the same shape.
 */
function renderSkillMd(slug: string, description: string, trigger: string, body: string): string {
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

function errText(msg: string) {
  return { isError: true, content: [{ type: 'text' as const, text: msg }] }
}
