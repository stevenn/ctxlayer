import { listUpstreamsForUser } from '../catalogue-views'
import { defineBuiltin } from '../builtins/types'
import { errText } from '../tool-result'

/**
 * `reload_upstreams` on the stateless lane.
 *
 * On the session lane this tool re-hydrates a long-lived registry. Here there
 * is nothing to re-hydrate — every request rebuilds the tool list from the
 * current catalogue and resolves credentials fresh — so the honest answer is
 * the current state plus what the caller can do if its own view is stale. The
 * tool stays registered because org skills and docs tell agents to call it
 * after connecting an upstream.
 */
export const reloadUpstreamsStateless = defineBuiltin({
  name: 'reload_upstreams',
  run: async (_args, { env, user }) => {
    const userId = user?.userId
    if (!userId) return errText('not_signed_in')
    const upstreams = await listUpstreamsForUser(env, userId)
    const body = {
      upstreams,
      note:
        'Nothing to reload on this connection: the tool list is rebuilt from the current ' +
        'catalogue on every request, and credentials are resolved fresh on every call. A ' +
        'newly connected or re-authorized upstream is already usable — if its tools are ' +
        'missing from your list, re-read the tool list (tools/list). list_upstreams has the ' +
        'per-upstream status.'
    }
    return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] }
  }
})
