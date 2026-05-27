/**
 * Bearer-gated /cli/skills/* routes for the @ctxlayer/cli commands.
 *
 * Registered as an `apiHandlers` route on the OAuth provider
 * (oauth/provider-config.ts). The provider validates the Bearer
 * token before this handler runs and attaches the issuing user's
 * props to `ctx.props` (McpProps shape: { userId, email, role }).
 *
 * Dispatch:
 *   GET  /cli/skills/export        — `ctxlayer pull` (any signed-in user)
 *   GET  /cli/skills/draft-context — `ctxlayer draft-skill` context bundle (admin)
 *   POST /cli/skills               — `ctxlayer draft-skill` create (admin)
 */

import {
  CreateSkillRequest,
  type DraftContextBundle,
  type SkillExportEntry,
  type SkillExportResponse
} from '@ctxlayer/shared'
import type { Env, McpProps } from '../env'
import { createSkill, listPublishedSkills } from '../db/queries/skills'
import { getUpstreamBySlug, listCachedTools } from '../db/queries/upstreams'
import {
  readSnapshot as readSkillSnapshot,
  writeRevisionAndSnapshot as writeSkillRevisionAndSnapshot
} from '../storage/skills-r2'
import { renderBlocksToMarkdown } from '../rag/markdown'
import { recordSkillRevision } from '../db/queries/skills'
import { lintSkillBody, type LintFinding } from '../skills/schema-linter'
import { buildUsageAggregates, findRelatedDocs } from '../skills/draft-context-bundle'
import { audit } from '../audit/log'

interface CliExportContext {
  props: McpProps | undefined
}

type CliFetchHandler = {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) => Promise<Response>
}

export const cliSkillsExportHandler: CliFetchHandler = {
  async fetch(req, env, ctx): Promise<Response> {
    const props = (ctx as ExecutionContext & CliExportContext).props
    if (!props || !props.userId) return jsonError('not_signed_in', 401)

    const url = new URL(req.url)
    const inner = url.pathname.replace(/^\/cli\/skills/, '')

    if (req.method === 'GET' && (inner === '' || inner === '/export')) {
      return await handleExport(env)
    }

    if (req.method === 'GET' && inner === '/draft-context') {
      if (props.role !== 'admin') return jsonError('forbidden', 403)
      return await handleDraftContext(env, url, props.userId)
    }

    if (req.method === 'POST' && inner === '') {
      if (props.role !== 'admin') return jsonError('forbidden', 403)
      return await handleCreate(env, req, props.userId)
    }

    return jsonError('not_found', 404)
  }
}

// ----- handlers ----------------------------------------------------------

async function handleExport(env: Env): Promise<Response> {
  try {
    const rows = await listPublishedSkills(env)
    const entries = await Promise.all(
      rows.map(async (row): Promise<SkillExportEntry> => {
        const snapshot = await readSkillSnapshot(env, row.id)
        const bodyMd = snapshot ? renderBlocksToMarkdown(snapshot.blocks) : ''
        return {
          slug: row.slug,
          name: row.slug,
          description: row.description,
          triggerText: row.trigger_text,
          bodyMd
        }
      })
    )
    const body: SkillExportResponse = { skills: entries }
    return json(body)
  } catch (err) {
    return logAndError('cli-skills-export build failed', err)
  }
}

async function handleDraftContext(env: Env, url: URL, userId: string): Promise<Response> {
  const upstreamSlug = url.searchParams.get('upstream')
  const toolName = url.searchParams.get('tool') ?? undefined
  const operatorPrompt = url.searchParams.get('prompt')

  if (!upstreamSlug) return jsonError('missing_upstream', 400)
  const upstream = await getUpstreamBySlug(env, upstreamSlug)
  if (!upstream) return jsonError('upstream_not_found', 404)
  if (upstream.transport !== 'streamable_http' && upstream.transport !== 'sse') {
    return jsonError('unsupported_transport', 400)
  }

  const cachedTools = await listCachedTools(env, upstream.id)
  const focus =
    toolName !== undefined ? cachedTools.find((t) => t.tool_name === toolName) ?? null : null
  if (toolName !== undefined && !focus) {
    return jsonError('tool_not_found', 404)
  }

  const styleRows = (await listPublishedSkills(env)).slice(0, 2)
  const [styleSkills, relatedDocs, usageAggregates] = await Promise.all([
    Promise.all(
      styleRows.map(async (row) => {
        const content = await readSkillSnapshot(env, row.id)
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
          description: focus.description,
          inputSchema: safeJsonParse(focus.input_schema),
          lastSchemaChangeAt: focus.last_schema_change_at
        }
      : null,
    allTools: cachedTools.map((t) => ({ name: t.tool_name, description: t.description })),
    relatedDocs,
    usageAggregates,
    styleSkills,
    operatorPrompt,
    generatedAt: Math.floor(Date.now() / 1000)
  }
  return json(bundle)
}

async function handleCreate(env: Env, req: Request, userId: string): Promise<Response> {
  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return jsonError('bad_request', 400)
  }
  const parsed = CreateSkillRequest.safeParse(raw)
  if (!parsed.success) {
    return new Response(
      JSON.stringify({ error: 'bad_request', issues: parsed.error.issues }),
      { status: 400, headers: { 'content-type': 'application/json' } }
    )
  }
  try {
    const { content, ...meta } = parsed.data
    const row = await createSkill(env, { ...meta, createdBy: userId })
    let lintFindings: LintFinding[] = []
    if (content) {
      const revisionId = crypto.randomUUID().replace(/-/g, '')
      const put = await writeSkillRevisionAndSnapshot(env, row.id, revisionId, content)
      await recordSkillRevision(env, {
        skillId: row.id,
        revisionId,
        authorId: userId,
        r2Key: put.key,
        byteSize: put.byteSize,
        contentHash: put.contentHash
      })
      // Lint after persist so the CLI sees warnings inline with the
      // save result. Non-fatal — never blocks.
      try {
        lintFindings = await lintSkillBody(env, row.id, content)
      } catch (lintErr) {
        console.error('skill linter failed (non-fatal):', lintErr)
      }
    }
    await audit(env, {
      actorId: userId,
      action: 'skill.create',
      target: row.id,
      meta: { source: 'cli', draftedBy: meta.drafterMeta ? 'cli' : 'manual' }
    })
    return new Response(
      JSON.stringify({ id: row.id, slug: row.slug, lintFindings }),
      { status: 201, headers: { 'content-type': 'application/json' } }
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/UNIQUE constraint failed/i.test(msg)) return jsonError('slug_taken', 409)
    return logAndError('cli-skills create failed', err)
  }
}

// ----- helpers ----------------------------------------------------------

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

function jsonError(code: string, status: number): Response {
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function logAndError(label: string, err: unknown): Response {
  console.error(`${label}:`, err instanceof Error ? err.message : String(err))
  return jsonError('internal_error', 500)
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return {}
  }
}
