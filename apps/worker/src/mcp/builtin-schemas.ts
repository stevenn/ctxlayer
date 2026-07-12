/**
 * Input schemas for ctxlayer's built-in MCP tools, extracted so a SINGLE
 * zod definition feeds BOTH the MCP registration (`session-do.ts` /
 * `skill-mcp.ts`) AND the `/api/tools` directory feed (converted to JSON
 * Schema for the SPA's schema viewer). One source means the schema the agent
 * is validated against can't drift from the schema humans see on /app/tools.
 *
 * Title + description still come from the shared BUILTIN_TOOLS catalogue (via
 * `builtinToolMeta`); only the *input shape* lives here — next to the handlers
 * that enforce it and the worker-side `SEARCH_K_MAX` bound. Built-ins that take
 * no arguments simply have no entry.
 */
import { z } from 'zod'
import { SearchScope } from '@ctxlayer/shared'
import { SEARCH_K_MAX } from '../rag/search'

// Per-tool zod raw shapes — spread into `registerTool`'s `inputSchema`.
// `satisfies` (not a wide annotation) keeps each shape's PRECISE type so the
// SDK can infer the handler's `args`; the `Record` check still guards the form.
export const BUILTIN_INPUT_SHAPES = {
  describe_upstream: {
    slug: z
      .string()
      .min(1)
      .describe('Upstream slug to describe, as shown by list_upstreams (e.g. "up-ado").'),
    family: z
      .string()
      .optional()
      .describe('Narrow to one family prefix (e.g. "wit", "repo"). Omit for all families.'),
    query: z
      .string()
      .optional()
      .describe('Narrow to tools whose native name or summary matches this text.')
  },
  get_doc: {
    id: z.string().min(1).describe('Document id or slug to fetch.')
  },
  search_docs: {
    query: z.string().min(1).describe('Natural-language search query.'),
    k: z
      .number()
      .int()
      .min(1)
      .max(SEARCH_K_MAX)
      .optional()
      .describe(`Number of results to return (1–${SEARCH_K_MAX}, default 8).`),
    // Same `SearchScope` the REST /api/search contract uses.
    scope: SearchScope.optional().describe(
      'Optional { teams, products } to narrow to docs carrying those tags (intersected with your reachable set). Omit (or "all") for open-read across all docs.'
    )
  },
  get_skill: {
    slug: z.string().min(1).describe('Skill slug to fetch, as listed by list_skills.')
  },
  active_users: {
    window: z
      .string()
      .regex(/^\d+[hd]$/)
      .optional()
      .describe(
        'Look-back window as `<n>h` or `<n>d` (e.g. "24h", "7d"). Default "24h"; clamped to [1h, 30d] (raw usage-event retention).'
      )
  },
  poll_task: {
    job_id: z
      .string()
      .min(1)
      .describe('The job id returned by an async tool submit (or by list_tasks).')
  },
  draft_skill: {
    upstreams: z
      .array(z.string())
      .min(1)
      .describe('Upstream slugs to draft against (e.g. ["up-ado","up-driver"]), from list_upstreams.'),
    intent: z
      .string()
      .optional()
      .describe('What the skill should help with. Omit to let the model propose one.'),
    tool: z
      .string()
      .optional()
      .describe('Optional native tool name to focus the skill on.')
  },
  save_draft_skill: {
    title: z.string().min(1).max(200).describe('Human display label for the skill (40-100 chars).'),
    description: z.string().min(1).max(500).describe('One-line "when to use" trigger.'),
    body: z.string().min(1).describe('The skill body as markdown.'),
    skillId: z
      .string()
      .optional()
      .describe(
        'To REVISE an existing skill of yours instead of creating a new one, pass its id (from an earlier save_draft_skill result) — it writes a new version of that skill. Also happens automatically when `slug` matches one of your own skills. Editing a PUBLISHED skill this way is live to the org.'
      ),
    slug: z
      .string()
      .optional()
      .describe(
        'Optional sk-<lowercase-hyphen> slug; derived from the title if omitted. If it matches one of your own skills, this UPDATES that skill (new version) rather than creating a duplicate.'
      ),
    triggerText: z
      .string()
      .max(500)
      .optional()
      .describe('Optional extra "when X" hints, appended before the body.'),
    upstreams: z
      .array(z.string())
      .optional()
      .describe(
        'The upstream slugs this skill was drafted against (e.g. ["up-ado","up-driver"]), from the `draft_skill` tool / `/draft-skill` prompt. Recorded so a reader can be warned when they cannot reach one.'
      )
  }
} satisfies Record<string, z.ZodRawShape>

/**
 * The JSON Schema for a built-in's input (for the directory feed / SPA), or
 * `undefined` when the tool takes no arguments. Derived from the same zod
 * shape the MCP server registers, so the two can never disagree.
 */
export function builtinInputJsonSchema(name: string): Record<string, unknown> | undefined {
  const shape = (BUILTIN_INPUT_SHAPES as Record<string, z.ZodRawShape>)[name]
  if (!shape) return undefined
  return z.toJSONSchema(z.object(shape)) as Record<string, unknown>
}
