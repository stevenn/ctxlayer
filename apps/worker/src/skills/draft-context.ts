/**
 * Assembles the `DraftContextBundle` the in-app `/draft-skill` MCP prompt
 * (mcp/session-do.ts) hands the connected agent so it can draft a skill
 * from this org's context — the MCP-native replacement for the retired
 * `ctxlayer draft-skill` CLI command. The caller supplies an already-split
 * `upstreamSlugs` array; everything downstream of a present slug (lookup,
 * transport check, tool resolution, bundle build) is this module's job.
 */

import {
  collapseSlugPrefix,
  mangleToolName,
  unmangleToolName,
  type DraftContextBundle,
  type SupportedTransport
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
    upstreamSlugs: string[]
    toolName: string | undefined
    operatorPrompt: string | null
    userId: string
  }
): Promise<DraftContextResult> {
  const { toolName, operatorPrompt, userId } = args
  // Dedup, preserve order; the first is the "anchor" upstream.
  const slugs = [...new Set(args.upstreamSlugs.filter(Boolean))]
  if (slugs.length === 0) return { ok: false, error: 'upstream_not_found', status: 404 }

  // Resolve identity + transport for every requested upstream first, so a
  // bad/undialable slug fails fast before the heavier enrichment work.
  const resolved: Array<{
    upstream: NonNullable<Awaited<ReturnType<typeof getUpstreamBySlug>>>
    // Captured here (post-guard) where isDialableTransport has narrowed it;
    // the narrowing wouldn't survive into the section-building loop below.
    transport: SupportedTransport
    cachedTools: Awaited<ReturnType<typeof listCachedTools>>
  }> = []
  for (const slug of slugs) {
    const upstream = await getUpstreamBySlug(env, slug)
    if (!upstream) return { ok: false, error: 'upstream_not_found', status: 404 }
    if (!isDialableTransport(upstream.transport)) {
      return { ok: false, error: 'unsupported_transport', status: 400 }
    }
    resolved.push({
      upstream,
      transport: upstream.transport,
      cachedTools: await listCachedTools(env, upstream.id)
    })
  }

  // House-style references — once for the whole bundle.
  const styleRows = (await listPublishedSkills(env)).slice(0, STYLE_SKILL_COUNT)
  const styleSkills = await Promise.all(
    styleRows.map(async (row) => {
      const content = await readSnapshot(env, row.id)
      const bodyMd = content ? renderBlocksToMarkdown(content.blocks) : ''
      return { slug: row.slug, title: row.title, bodyMd }
    })
  )

  // Per-upstream sections (focus + usage) + a relatedDocs set unioned and
  // deduped by slug across the chosen upstreams.
  const upstreams: DraftContextBundle['upstreams'] = []
  const relatedSeen = new Set<string>()
  const relatedDocs: DraftContextBundle['relatedDocs'] = []
  let anyFocusMatched = false

  for (const { upstream, transport, cachedTools } of resolved) {
    // Accept the focus tool in any form the operator knows (raw
    // `notion-search`, collapsed `search`, or mangled `notion__search`).
    // A single --tool is matched against EACH upstream; whichever owns it
    // gets the focus, the rest get null.
    const focus =
      toolName !== undefined ? resolveCachedTool(cachedTools, upstream.slug, toolName) : null
    if (focus) anyFocusMatched = true

    const [related, usageAggregates] = await Promise.all([
      findRelatedDocs(env, { upstreamSlug: upstream.slug, toolName: focus?.tool_name }),
      buildUsageAggregates(env, {
        userId,
        upstreamId: upstream.id,
        upstreamSlug: upstream.slug,
        toolName: focus?.tool_name
      })
    ])
    for (const d of related) {
      if (relatedSeen.has(d.slug)) continue
      relatedSeen.add(d.slug)
      relatedDocs.push(d)
    }

    upstreams.push({
      slug: upstream.slug,
      displayName: upstream.display_name,
      transport,
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
      usageAggregates
    })
  }

  // A focus tool was requested but matched none of the chosen upstreams.
  if (toolName !== undefined && !anyFocusMatched) {
    return { ok: false, error: 'tool_not_found', status: 404 }
  }

  return {
    ok: true,
    bundle: {
      upstreams,
      relatedDocs,
      styleSkills,
      operatorPrompt,
      generatedAt: Math.floor(Date.now() / 1000)
    }
  }
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
