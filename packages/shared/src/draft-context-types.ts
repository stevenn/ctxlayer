import { z } from 'zod'

/**
 * Context bundle returned by GET /api/skills/draft-context. Designed to
 * inline into a Claude Code prompt so the CLI's `draft-skill` command
 * can shell `claude -p` without doing further server roundtrips.
 *
 * v1 ships the deterministic sections only (upstream, focusTool,
 * allTools, styleSkills, operatorPrompt). usageAggregates +
 * relatedDocs are placeholders — see M8 design for the full plan.
 */

export const DraftContextUpstream = z.object({
  slug: z.string(),
  displayName: z.string(),
  transport: z.enum(['streamable_http', 'sse'])
})

export const DraftContextTool = z.object({
  // Raw upstream tool name (as cached on `upstream_tools.tool_name`).
  name: z.string(),
  // Agent-callable name. ALWAYS use this verbatim in skill bodies —
  // it's the same string the model uses to call the tool over MCP,
  // after our slug-prefix collapse rule. The model otherwise tends
  // to guess wrong (e.g. notion__notion-search instead of notion__search).
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

export const DraftContextBundle = z.object({
  upstream: DraftContextUpstream,
  focusTool: DraftContextTool.nullable(),
  allTools: z.array(DraftContextLightTool),
  // M8 v1 ships these as empty arrays / null; populate via follow-up.
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
  usageAggregates: z
    .object({
      totalCalls: z.number().int(),
      callsByDay: z.array(z.object({ day: z.string(), count: z.number().int() })),
      topArgPatterns: z.array(z.object({ argSummary: z.string(), count: z.number().int() }))
    })
    .nullable(),
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
