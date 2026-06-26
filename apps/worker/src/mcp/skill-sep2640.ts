/**
 * SEP-2640 "Skills Extension" surface. Serves the same published skills
 * over the standardised `skill://` URI scheme plus a `skill://index.json`
 * discovery document, and advertises the `io.modelcontextprotocol/skills`
 * extension capability at initialize.
 *
 * This is additive future-proofing. The canonical surface is still
 * `list_skills` / `get_skill` + the `mcp://ctxlayer/skills/{slug}`
 * resource (skill-mcp.ts). SEP-2640 is a draft MCP extension (Resources-
 * based; in review as of 2026-06) — when hosts ship a consumer, ctxlayer
 * already speaks it. Format (SKILL.md frontmatter) is delegated to the
 * agentskills.io spec.
 * Spec: https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2640
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Env } from '../env'
import { listPublishedSkills } from '../db/queries/skills'
import { loadPublishedSkillMarkdown } from './skill-render'

const SKILLS_EXTENSION_ID = 'io.modelcontextprotocol/skills'
const DISCOVERY_SCHEMA = 'https://schemas.agentskills.io/discovery/0.2.0/schema.json'

export interface SkillIndexEntry {
  name: string
  type: 'skill-md'
  description: string
  url: string
}

export interface SkillIndexDoc {
  $schema: string
  skills: SkillIndexEntry[]
}

/**
 * Build the SEP-2640 `skill://index.json` discovery document from the
 * published-skill rows. Pure (no env) so it's unit-testable; each entry
 * is a `skill-md` pointing at the skill's `skill://<slug>/SKILL.md` body.
 */
export function buildSkillIndex(
  rows: Array<{ slug: string; description: string }>
): SkillIndexDoc {
  return {
    $schema: DISCOVERY_SCHEMA,
    skills: rows.map((r) => ({
      name: r.slug,
      type: 'skill-md',
      description: r.description,
      url: `skill://${r.slug}/SKILL.md`
    }))
  }
}

export function registerSkillSep2640(server: McpServer, env: Env): void {
  // Advertise the extension at initialize (empty object = supported, no
  // settings). registerCapabilities merges by top-level key, so this does
  // not disturb the tools/resources capabilities McpServer derives from
  // the registrations below. Runs before the transport connects.
  server.server.registerCapabilities({
    extensions: { [SKILLS_EXTENSION_ID]: {} }
  })

  // skill://{slug}/SKILL.md — the body, per the SEP `skill://<path>/<file>`
  // layout. ctxlayer skills are flat, so <path> is the single-segment slug
  // and <file> is always SKILL.md.
  const bodyTemplate = new ResourceTemplate('skill://{slug}/SKILL.md', {
    list: async () => {
      const rows = await listPublishedSkills(env)
      return {
        resources: rows.map((r) => ({
          uri: `skill://${r.slug}/SKILL.md`,
          name: r.title,
          description: r.description,
          mimeType: 'text/markdown'
        }))
      }
    }
  })

  server.registerResource(
    'skill-sep2640',
    bodyTemplate,
    {
      title: 'Skills (skill:// — SEP-2640)',
      description: 'Curated skills over the standard skill:// URI scheme.'
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

  // skill://index.json — the discovery document. The body template above
  // does not match this URI (its trailing literal is /SKILL.md), so the
  // exact-match static resource and the template never collide on read.
  server.registerResource(
    'skill-index',
    'skill://index.json',
    {
      title: 'Skill catalog (SEP-2640 discovery)',
      description: 'skill:// discovery document listing published skills.',
      mimeType: 'application/json'
    },
    async (uri: URL) => {
      const rows = await listPublishedSkills(env)
      const index = buildSkillIndex(rows)
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: 'application/json',
            text: JSON.stringify(index, null, 2)
          }
        ]
      }
    }
  )
}
