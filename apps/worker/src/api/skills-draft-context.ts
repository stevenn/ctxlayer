/**
 * GET /api/skills/draft-context?upstream=<slug>&tool=<name>&prompt=<text>
 *
 * Assembles the context bundle the `ctxlayer draft-skill` CLI command
 * inlines into its `claude -p` prompt. Admin-gated; no LLM is invoked
 * on the worker.
 *
 * M8 v1 ships the deterministic sections only:
 *   - upstream metadata
 *   - focusTool (if --tool param present)
 *   - allTools (light catalogue for cross-references)
 *   - styleSkills (2 most-recent published as house-style refs)
 *   - operatorPrompt echo
 *
 * Deferred (placeholder empty/null in v1):
 *   - relatedDocs (needs Vectorize query reuse)
 *   - usageAggregates (needs usage_events aggregation queries)
 */

import { Hono } from 'hono'
import {
  collapseSlugPrefix,
  mangleToolName,
  unmangleToolName,
  type DraftContextBundle
} from '@ctxlayer/shared'
import type { Env } from '../env'
import { requireAdmin, type AuthedVariables } from '../auth/middleware'
import { getUpstreamBySlug, listCachedTools } from '../db/queries/upstreams'
import { listPublishedSkills } from '../db/queries/skills'
import { readSnapshot } from '../storage/skills-r2'
import { renderBlocksToMarkdown } from '../rag/markdown'
import { buildUsageAggregates, findRelatedDocs } from '../skills/draft-context-bundle'

export const skillsDraftContextRoute = new Hono<{
  Bindings: Env
  Variables: AuthedVariables
}>()
skillsDraftContextRoute.use('*', requireAdmin)

skillsDraftContextRoute.get('/', async (c) => {
  const upstreamSlug = c.req.query('upstream')
  const toolName = c.req.query('tool')
  const operatorPrompt = c.req.query('prompt') ?? null

  if (!upstreamSlug) return c.json({ error: 'missing_upstream' }, 400)
  const upstream = await getUpstreamBySlug(c.env, upstreamSlug)
  if (!upstream) return c.json({ error: 'upstream_not_found' }, 404)
  if (upstream.transport !== 'streamable_http' && upstream.transport !== 'sse') {
    return c.json({ error: 'unsupported_transport' }, 400)
  }

  const cachedTools = await listCachedTools(c.env, upstream.id)
  // Tolerate raw / collapsed / mangled forms — see cli-skills-export.ts's
  // resolveCachedTool helper for the rationale (same problem the CLI hit).
  const focus =
    toolName !== undefined ? resolveCachedTool(cachedTools, upstream.slug, toolName) : null
  if (toolName !== undefined && !focus) {
    return c.json({ error: 'tool_not_found' }, 404)
  }

  const userId = c.get('user').userId
  const styleSkillRows = (await listPublishedSkills(c.env)).slice(0, 2)
  const [styleSkills, relatedDocs, usageAggregates] = await Promise.all([
    Promise.all(
      styleSkillRows.map(async (row) => {
        const content = await readSnapshot(c.env, row.id)
        const bodyMd = content ? renderBlocksToMarkdown(content.blocks) : ''
        return { slug: row.slug, title: row.title, bodyMd }
      })
    ),
    findRelatedDocs(c.env, {
      upstreamSlug: upstream.slug,
      toolName: focus?.tool_name
    }),
    buildUsageAggregates(c.env, {
      userId,
      upstreamId: upstream.id,
      upstreamSlug: upstream.slug,
      toolName: focus?.tool_name
    })
  ])

  const bundle: DraftContextBundle = {
    upstream: {
      slug: upstream.slug,
      displayName: upstream.display_name,
      transport: upstream.transport
    },
    focusTool: focus
      ? {
          name: focus.tool_name,
          mangledName: mangleToolName(upstream.slug, focus.tool_name),
          description: focus.description,
          inputSchema: safeJsonParse(focus.input_schema),
          lastSchemaChangeAt: focus.last_schema_change_at
        }
      : null,
    allTools: cachedTools.map((t) => ({
      name: t.tool_name,
      mangledName: mangleToolName(upstream.slug, t.tool_name),
      description: t.description
    })),
    relatedDocs,
    usageAggregates,
    styleSkills,
    operatorPrompt,
    generatedAt: Math.floor(Date.now() / 1000)
  }
  return c.json(bundle)
})

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return {}
  }
}

function resolveCachedTool<T extends { tool_name: string }>(
  rows: T[],
  upstreamSlug: string,
  reference: string
): T | null {
  const exact = rows.find((r) => r.tool_name === reference)
  if (exact) return exact
  const unmangled = unmangleToolName(reference)
  if (unmangled && unmangled.slug === upstreamSlug) {
    const fromMangled = rows.find(
      (r) =>
        r.tool_name === unmangled.toolName ||
        collapseSlugPrefix(upstreamSlug, r.tool_name) === unmangled.toolName
    )
    if (fromMangled) return fromMangled
  }
  const collapsed = rows.find((r) => collapseSlugPrefix(upstreamSlug, r.tool_name) === reference)
  if (collapsed) return collapsed
  const remangled = rows.find((r) => mangleToolName(upstreamSlug, r.tool_name) === reference)
  return remangled ?? null
}
