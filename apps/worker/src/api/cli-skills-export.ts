/**
 * Bearer-gated skill export for the @ctxlayer/cli `pull` command.
 *
 * Registered as an `apiHandlers` route on the OAuth provider in
 * oauth/provider-config.ts. That means the provider validates the
 * Bearer token before this handler runs and attaches the issuing
 * user's props to `ctx.props` (McpProps shape: { userId, email, role }).
 *
 * Mirrors `apps/worker/src/api/skills-export.ts` (the cookie-gated
 * variant) — both produce the same SkillExportResponse shape. Kept
 * separate because the cookie-gated route lives in the Hono app and
 * the bearer-gated route lives in apiHandlers; merging them would
 * require dual-validating cookie + bearer in one path and is more
 * surface than it's worth for this single endpoint.
 */

import type { SkillExportEntry, SkillExportResponse } from '@ctxlayer/shared'
import type { Env, McpProps } from '../env'
import { listPublishedSkills } from '../db/queries/skills'
import { readSnapshot } from '../storage/skills-r2'
import { renderBlocksToMarkdown } from '../rag/markdown'

interface CliExportContext {
  props: McpProps | undefined
}

async function build(env: Env): Promise<SkillExportResponse> {
  const rows = await listPublishedSkills(env)
  const entries = await Promise.all(
    rows.map(async (row): Promise<SkillExportEntry> => {
      const snapshot = await readSnapshot(env, row.id)
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
  return { skills: entries }
}

type CliFetchHandler = {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) => Promise<Response>
}

export const cliSkillsExportHandler: CliFetchHandler = {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // OAuth provider validated the bearer + attached user props on
    // ctx.props. Without props we have no user context — refuse.
    const props = (ctx as ExecutionContext & CliExportContext).props
    if (!props || !props.userId) {
      return new Response(JSON.stringify({ error: 'not_signed_in' }), {
        status: 401,
        headers: { 'content-type': 'application/json' }
      })
    }

    const url = new URL(req.url)
    const path = url.pathname.replace(/^\/cli\/skills/, '')
    if (req.method !== 'GET' || (path !== '' && path !== '/export')) {
      return new Response(JSON.stringify({ error: 'not_found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' }
      })
    }

    try {
      const body = await build(env)
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('cli-skills-export build failed:', message)
      return new Response(JSON.stringify({ error: 'internal_error' }), {
        status: 500,
        headers: { 'content-type': 'application/json' }
      })
    }
  }
}
