import { z } from 'zod'
import type { Env } from '../env'
import { buildDraftContext } from '../skills/draft-context'
import { buildDraftSkillMessages, draftPromptNotice } from '../skills/drafter-prompt'
import type { McpSurface } from './surface'

/**
 * The `/draft-skill` prompt.
 *
 * In-app AI drafting with NO server-side LLM: this prompt hands the
 * connected agent the org's context bundle (`buildDraftContext`) + the
 * drafter guidance; the agent persists its draft through the
 * `save_draft_skill` tool. The `draft_skill` tool is this prompt's twin for
 * clients that don't render MCP prompts (both tools: `mcp/builtins/`).
 *
 * `buildDraftContext` applies the visibility + per-tool ACL gates, so the
 * bundle only ever describes upstreams the caller was granted.
 */
export function registerDraftSkillPrompt(
  surface: McpSurface,
  env: Env,
  getUserId: () => string | undefined
): void {
  surface.registerPrompt(
    'draft-skill',
    {
      title: 'Draft a skill',
      description:
        "Draft a ctxlayer skill for one or more upstreams using this org's context, then save it as your private draft. `upstreams` is a comma-separated list of slugs from list_upstreams; `intent` and `tool` are optional.",
      argsSchema: {
        upstreams: z
          .string()
          .describe('Comma-separated upstream slugs to draft against (e.g. "up-ado,up-driver").'),
        intent: z
          .string()
          .optional()
          .describe('What the skill should help with. Omit to let the model propose one.'),
        tool: z.string().optional().describe('Optional native tool name to focus the skill on.')
      }
    },
    async (args) => {
      const userId = getUserId()
      if (!userId) {
        return draftPromptNotice('You are not signed in to ctxlayer, so a skill cannot be drafted.')
      }
      const slugs = (args.upstreams ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      const result = await buildDraftContext(env, {
        upstreamSlugs: slugs,
        toolName: args.tool || undefined,
        operatorPrompt: args.intent || null,
        userId
      })
      if (!result.ok) {
        return draftPromptNotice(
          `Could not build the draft context (${result.error}). Check the upstream slug(s) with list_upstreams and try again.`
        )
      }
      return buildDraftSkillMessages(result.bundle)
    }
  )
}
