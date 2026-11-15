import { buildDraftContext } from '../../skills/draft-context'
import { buildDraftSkillText } from '../../skills/drafter-prompt'
import { SaveDraftSkillError, saveDraftSkill } from '../../skills/save-draft-skill'
import { errMessage } from '../../util/errors'
import { BUILTIN_INPUT_SHAPES } from '../builtin-schemas'
import { errText } from '../tool-result'
import { defineBuiltin } from './types'

// In-app AI drafting with NO server-side LLM: `draft_skill` hands the
// connected agent this org's context bundle (buildDraftContext) + the drafter
// guidance; the agent persists its draft through `save_draft_skill`. The
// user's own agent does the generation.

/**
 * `draft_skill` — tool twin of the /draft-skill prompt, so the flow works on
 * clients that don't render MCP prompts. Open to every signed-in user, so the
 * visibility + per-tool ACL gates inside `buildDraftContext` are what keep it
 * from becoming a read oracle for ungranted upstreams.
 */
export const draftSkill = defineBuiltin({
  name: 'draft_skill',
  inputShape: BUILTIN_INPUT_SHAPES.draft_skill,
  run: async (args, { env, user }) => {
    const userId = user?.userId
    if (!userId) return errText('not_signed_in')
    const result = await buildDraftContext(env, {
      upstreamSlugs: args.upstreams,
      toolName: args.tool || undefined,
      operatorPrompt: args.intent || null,
      userId
    })
    if (!result.ok) {
      return errText(
        `context_build_failed: ${result.error}. Check the upstream slug(s) with list_upstreams.`
      )
    }
    return { content: [{ type: 'text', text: buildDraftSkillText(result.bundle) }] }
  }
})

/** `save_draft_skill` — upsert the caller's own skill (new revision on update). */
export const saveDraftSkillTool = defineBuiltin({
  name: 'save_draft_skill',
  inputShape: BUILTIN_INPUT_SHAPES.save_draft_skill,
  run: async (args, { env, user }) => {
    const userId = user?.userId
    if (!userId) return errText('not_signed_in')
    try {
      const res = await saveDraftSkill(env, {
        userId,
        role: user?.role,
        title: args.title,
        description: args.description,
        body: args.body,
        slug: args.slug,
        triggerText: args.triggerText,
        upstreams: args.upstreams,
        skillId: args.skillId
      })
      const warnings =
        res.lintFindings.length > 0
          ? '\n\nSchema-linter warnings (non-blocking):\n' +
            res.lintFindings.map((f) => `- ${f.reference} (${f.kind})`).join('\n')
          : ''
      // Create vs update-in-place; when updating a PUBLISHED skill the
      // change is live to the org, so say so.
      let text: string
      if (res.created) {
        text =
          `Saved "${args.title}" as your private draft (slug: ${res.slug}). ` +
          `Refine and share it at /app/skills/${res.id}/edit.`
      } else if (res.status === 'published') {
        text =
          `Updated your PUBLISHED skill "${args.title}" (slug: ${res.slug}, now version ${res.version}). ` +
          `This change is LIVE to the org. Edit or roll back at /app/skills/${res.id}/edit.`
      } else {
        text =
          `Updated your ${res.status} skill "${args.title}" (slug: ${res.slug}, now version ${res.version}). ` +
          `Refine and share it at /app/skills/${res.id}/edit.`
      }
      return { content: [{ type: 'text', text: text + warnings }] }
    } catch (err) {
      if (err instanceof SaveDraftSkillError) return errText(err.code)
      const msg = errMessage(err)
      if (/UNIQUE constraint failed/i.test(msg)) return errText('slug_taken')
      console.error('save_draft_skill failed:', msg)
      return errText('save_failed')
    }
  }
})
