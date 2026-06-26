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
import { listPublishedSkills } from '../db/queries/skills'
import { listAttachmentsForSkills } from '../db/queries/skill-attachments'
import { type McpSkillSummary, McpListSkillsResult } from '@ctxlayer/shared'
import { loadPublishedSkillMarkdown } from './skill-render'
import { registerSkillSep2640 } from './skill-sep2640'

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
        'Lists org-curated skills (procedural playbooks the agent can load on demand). Each entry carries the SKILL.md `name`, a one-line `description` (when to invoke), and the upstream tools it is attached to. Only published skills surface.',
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
        // Typed against the shared MCP contract (`McpSkillSummary`).
        const summaries: McpSkillSummary[] = rows.map((row) => ({
          slug: row.slug,
          name: row.slug,
          title: row.title,
          description: row.description,
          attached_to: (attachmentsBySkill.get(row.id) ?? []).map((a) => ({
            upstream_slug: a.upstream_slug,
            tool_name: a.tool_name || null
          }))
        }))
        return {
          content: [{ type: 'text', text: JSON.stringify(summaries, null, 2) }],
          structuredContent: { skills: summaries }
        }
      })
  )

  server.registerTool(
    'get_skill',
    {
      title: 'Get skill',
      description: 'Fetches a skill body by slug. Returns SKILL.md frontmatter + body in markdown.',
      inputSchema: { slug: z.string().min(1) }
    },
    (args) =>
      rec('get_skill', args, async () => {
        const md = await loadPublishedSkillMarkdown(env, args.slug)
        if (md == null) return errText(`skill not found: ${args.slug}`)
        return { content: [{ type: 'text', text: md }] }
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

// ----- helpers -----------------------------------------------------------

function errText(msg: string) {
  return { isError: true, content: [{ type: 'text' as const, text: msg }] }
}
