import { McpListUpstreamsResult, McpUpstreamTools } from '@ctxlayer/shared'
import { BUILTIN_INPUT_SHAPES } from '../builtin-schemas'
import { describeUpstreamForUser, listUpstreamsForUser } from '../catalogue-views'
import { errText } from '../tool-result'
import { defineBuiltin, jsonResult } from './types'

/**
 * `list_upstreams` — the caller's visible upstreams with their attachments.
 * Visibility-gated inside `listUpstreamsForUser`.
 */
export const listUpstreams = defineBuiltin({
  name: 'list_upstreams',
  // structuredContent must be an object, so the entry array is wrapped
  // under `upstreams`. The text `content` keeps the bare array for
  // back-compat with clients that read the rendered JSON.
  outputShape: { upstreams: McpListUpstreamsResult },
  run: async (_args, { env, user }) => {
    const userId = user?.userId
    if (!userId) return errText('not_signed_in')
    const entries = await listUpstreamsForUser(env, userId)
    return {
      content: [{ type: 'text', text: JSON.stringify(entries, null, 2) }],
      structuredContent: { upstreams: entries }
    }
  }
})

/**
 * `describe_upstream` — one upstream's tools by native name. Gated twice
 * inside `describeUpstreamForUser` (visibility, then per-tool ACL): an
 * ungranted slug is indistinguishable from a nonexistent one.
 */
export const describeUpstream = defineBuiltin({
  name: 'describe_upstream',
  inputShape: BUILTIN_INPUT_SHAPES.describe_upstream,
  outputShape: McpUpstreamTools.shape,
  run: async (args, { env, user }) => {
    const userId = user?.userId
    if (!userId) return errText('not_signed_in')
    const body = await describeUpstreamForUser(env, userId, args.slug, {
      family: args.family,
      query: args.query
    })
    if (!body) return errText(`upstream not found: ${args.slug}`)
    return jsonResult(body)
  }
})
