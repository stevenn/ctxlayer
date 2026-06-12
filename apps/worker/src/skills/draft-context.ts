/**
 * Assembles the `DraftContextBundle` the `ctxlayer draft-skill` CLI
 * command inlines into its `claude -p` prompt. Shared by the bearer-
 * gated CLI handler (`cli-export-handler.ts`) and the SPA route
 * (`api/skills-draft-context.ts`) — both must serve the exact same
 * shape, so the assembly lives here once. Admin-gating and the
 * missing-`upstream`-param check stay at the surfaces; everything
 * downstream of a present slug (lookup, transport check, tool
 * resolution, bundle build) is this module's job.
 */

import {
  collapseSlugPrefix,
  mangleToolName,
  unmangleToolName,
  type DraftContextBundle
} from '@ctxlayer/shared'
import type { Env } from '../env'
import { getUpstreamBySlug } from '../db/queries/upstreams'
import { listCachedTools } from '../db/queries/upstream-tools'
import { listPublishedSkills } from '../db/queries/skills'
import { readSnapshot } from '../storage/skills-r2'
import { renderBlocksToMarkdown } from '../rag/markdown'
import { isDialableTransport } from '../upstream/upstream-client'
import { buildUsageAggregates, findRelatedDocs } from './draft-context-bundle'

/** 2 most-recent published skills ship as house-style references. */
const STYLE_SKILL_COUNT = 2

export type DraftContextResult =
  | { ok: true; bundle: DraftContextBundle }
  | {
      ok: false
      error: 'upstream_not_found' | 'unsupported_transport' | 'tool_not_found'
      status: 400 | 404
    }

export async function buildDraftContext(
  env: Env,
  args: {
    upstreamSlug: string
    toolName: string | undefined
    operatorPrompt: string | null
    userId: string
  }
): Promise<DraftContextResult> {
  const { upstreamSlug, toolName, operatorPrompt, userId } = args
  const upstream = await getUpstreamBySlug(env, upstreamSlug)
  if (!upstream) return { ok: false, error: 'upstream_not_found', status: 404 }
  if (!isDialableTransport(upstream.transport)) {
    return { ok: false, error: 'unsupported_transport', status: 400 }
  }

  const cachedTools = await listCachedTools(env, upstream.id)
  // Accept the tool reference in any of the three forms the operator
  // might know about: raw upstream name (`notion-search`), collapsed
  // form (`search`), or fully mangled (`notion__search`). All three
  // resolve to the same cached row.
  const focus =
    toolName !== undefined ? resolveCachedTool(cachedTools, upstream.slug, toolName) : null
  if (toolName !== undefined && !focus) {
    return { ok: false, error: 'tool_not_found', status: 404 }
  }

  const styleRows = (await listPublishedSkills(env)).slice(0, STYLE_SKILL_COUNT)
  const [styleSkills, relatedDocs, usageAggregates] = await Promise.all([
    Promise.all(
      styleRows.map(async (row) => {
        const content = await readSnapshot(env, row.id)
        const bodyMd = content ? renderBlocksToMarkdown(content.blocks) : ''
        return { slug: row.slug, title: row.title, bodyMd }
      })
    ),
    findRelatedDocs(env, {
      upstreamSlug: upstream.slug,
      toolName: focus?.tool_name
    }),
    buildUsageAggregates(env, {
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
  return { ok: true, bundle }
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return {}
  }
}

/**
 * Resolve an operator-supplied tool reference to a cached row. The
 * operator may pass the raw upstream name (`notion-search`), the
 * post-collapse form they see in the UI (`search`), or the fully
 * mangled agent-callable name (`notion__search`). Tries each in turn.
 */
function resolveCachedTool<T extends { tool_name: string }>(
  rows: T[],
  upstreamSlug: string,
  reference: string
): T | null {
  // 1. Exact raw match.
  const exact = rows.find((r) => r.tool_name === reference)
  if (exact) return exact
  // 2. Mangled form supplied — split and match the upstream side.
  const unmangled = unmangleToolName(reference)
  if (unmangled && unmangled.slug === upstreamSlug) {
    // The unmangled toolName might be the collapsed form (`search`) or
    // the raw form (`notion-search`); try collapse-aware compare on each
    // cached row.
    const fromMangled = rows.find(
      (r) =>
        r.tool_name === unmangled.toolName ||
        collapseSlugPrefix(upstreamSlug, r.tool_name) === unmangled.toolName
    )
    if (fromMangled) return fromMangled
  }
  // 3. Collapse-form match: reference is the short name, cached row has
  //    the slug-prefixed variant (e.g. ref=`search`, row=`notion-search`).
  const collapsed = rows.find((r) => collapseSlugPrefix(upstreamSlug, r.tool_name) === reference)
  if (collapsed) return collapsed
  // 4. Last-ditch: the operator may have re-applied the mangle by hand.
  const remangled = rows.find((r) => mangleToolName(upstreamSlug, r.tool_name) === reference)
  return remangled ?? null
}
