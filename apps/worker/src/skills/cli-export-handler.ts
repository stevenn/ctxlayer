/**
 * Bearer-gated /cli/skills/* handler for the @ctxlayer/cli commands.
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
 *
 * Thin shell: the export / draft-context payloads are assembled by the
 * shared builders in `export.ts` / `draft-context.ts` (also used by the
 * SPA REST surface); this module only does auth, dispatch, and the
 * CLI-only skill-create flow.
 */

import { CreateSkillRequest } from '@ctxlayer/shared'
import type { Env, McpProps } from '../env'
import { createSkill, recordSkillRevision } from '../db/queries/skills'
import { writeRevisionAndSnapshot as writeSkillRevisionAndSnapshot } from '../storage/skills-r2'
import { lintSkillBody, type LintFinding } from './schema-linter'
import { buildSkillExport } from './export'
import { buildDraftContext, parseUpstreamSlugs } from './draft-context'
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
    return json(await buildSkillExport(env))
  } catch (err) {
    return logAndError('cli-skills-export build failed', err)
  }
}

async function handleDraftContext(env: Env, url: URL, userId: string): Promise<Response> {
  const upstreamSlugs = parseUpstreamSlugs(
    url.searchParams.get('upstreams'),
    url.searchParams.get('upstream')
  )
  if (upstreamSlugs.length === 0) return jsonError('missing_upstream', 400)
  const result = await buildDraftContext(env, {
    upstreamSlugs,
    toolName: url.searchParams.get('tool') ?? undefined,
    operatorPrompt: url.searchParams.get('prompt'),
    userId
  })
  if (!result.ok) return jsonError(result.error, result.status)
  return json(result.bundle)
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
    return new Response(JSON.stringify({ error: 'bad_request', issues: parsed.error.issues }), {
      status: 400,
      headers: { 'content-type': 'application/json' }
    })
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
    return new Response(JSON.stringify({ id: row.id, slug: row.slug, lintFindings }), {
      status: 201,
      headers: { 'content-type': 'application/json' }
    })
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
