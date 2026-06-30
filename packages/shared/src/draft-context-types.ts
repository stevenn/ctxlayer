import { z } from 'zod'

/**
 * Context bundle returned by GET /api/skills/draft-context. Designed to
 * inline into a Claude Code prompt so the CLI's `draft-skill` command
 * can shell `claude -p` without doing further server roundtrips.
 *
 * Carries ONE OR MORE upstream sections (`upstreams[]`), each with its
 * tool catalogue + optional focus tool + usage rollup, so a single draft
 * can span several upstreams (e.g. Driver code-intel + ADO history) as
 * one workflow. `relatedDocs` is unioned across them; `styleSkills` are
 * house-style references.
 */

export const DraftContextUpstream = z.object({
  slug: z.string(),
  displayName: z.string(),
  transport: z.enum(['streamable_http', 'sse'])
})

export const DraftContextTool = z.object({
  // Raw upstream tool name (as cached on `upstream_tools.tool_name`).
  name: z.string(),
  // Agent-callable name (after our slug-prefix collapse rule). Kept for
  // reference + the schema-linter — do NOT inline it into skill bodies.
  // Bodies should use the native `name` and name the owning upstream in
  // prose (drafter prompt v4+) so they stay portable across
  // re-registration / reuse on another install.
  mangledName: z.string(),
  description: z.string().nullable(),
  inputSchema: z.unknown(),
  lastSchemaChangeAt: z.number().int().nullable()
})

export const DraftContextStyleSkill = z.object({
  slug: z.string(),
  title: z.string(),
  bodyMd: z.string()
})

export const DraftContextLightTool = z.object({
  name: z.string(),
  // Agent-callable name; see DraftContextTool.mangledName.
  mangledName: z.string(),
  description: z.string().nullable()
})

/** Per-(user, upstream, tool) usage rollup over the lookback window. */
export const DraftContextUsage = z.object({
  totalCalls: z.number().int(),
  callsByDay: z.array(z.object({ day: z.string(), count: z.number().int() })),
  topArgPatterns: z.array(z.object({ argSummary: z.string(), count: z.number().int() }))
})
export type DraftContextUsage = z.infer<typeof DraftContextUsage>

/**
 * One upstream's slice of the bundle: its identity plus its tool
 * catalogue (`allTools`), an optional `focusTool` schema, and its own
 * usage rollup. A skill may combine several of these into one workflow.
 */
export const DraftContextUpstreamSection = DraftContextUpstream.extend({
  focusTool: DraftContextTool.nullable(),
  allTools: z.array(DraftContextLightTool),
  usageAggregates: DraftContextUsage.nullable()
})
export type DraftContextUpstreamSection = z.infer<typeof DraftContextUpstreamSection>

export const DraftContextBundle = z.object({
  // One or more upstreams — `draft-skill <anchor> --with <slug> …`. A
  // multi-upstream bundle drives a single cross-upstream workflow skill.
  upstreams: z.array(DraftContextUpstreamSection).min(1),
  // RAG-grounded docs, unioned across the chosen upstreams (deduped by slug).
  relatedDocs: z
    .array(
      z.object({
        slug: z.string(),
        title: z.string(),
        excerpt: z.string(),
        relevanceScore: z.number().optional()
      })
    )
    .default([]),
  styleSkills: z.array(DraftContextStyleSkill),
  operatorPrompt: z.string().nullable(),
  generatedAt: z.number().int()
})
export type DraftContextBundle = z.infer<typeof DraftContextBundle>

export const DrafterMeta = z.object({
  from: z.enum(['cli+claude-code', 'cli+claude-code+agentic', 'manual']),
  model: z.string().optional(),
  modelVersion: z.string().optional(),
  contextInputs: z.array(z.string()).optional(),
  operatorPromptProvided: z.boolean().optional(),
  claudeCodeVersion: z.string().optional(),
  draftedAt: z.number().int().optional()
})
export type DrafterMeta = z.infer<typeof DrafterMeta>
