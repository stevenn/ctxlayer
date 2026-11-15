import { McpMyContext } from '@ctxlayer/shared'
import { resolveUserScope } from '../../db/queries/doc-tags'
import { listUserRoleIds } from '../../db/queries/roles'
import { listUpstreamsVisibleToUser } from '../../db/queries/upstreams'
import { restrictedToolsFor } from '../catalogue-views'
import { errText } from '../tool-result'
import { defineBuiltin, jsonResult } from './types'

/** `whoami` — diagnostic: the props attached to this caller. */
export const whoami = defineBuiltin({
  name: 'whoami',
  run: async (_args, { user }) => ({
    content: [{ type: 'text', text: JSON.stringify(user ?? null, null, 2) }]
  })
})

/** `list_my_context` — teams, products, reachable upstreams, default scope. */
export const listMyContext = defineBuiltin({
  name: 'list_my_context',
  outputShape: McpMyContext.shape,
  run: async (_args, { env, user }) => {
    const userId = user?.userId
    if (!userId) return errText('not_signed_in')
    // Scope, roles, and the visible-upstream rows are fetched once
    // and feed BOTH the context body and the restricted-tools
    // advisory (which used to re-run all three internally).
    const [scope, roleIds, rows] = await Promise.all([
      resolveUserScope(env, userId),
      listUserRoleIds(env, userId),
      listUpstreamsVisibleToUser(env, userId)
    ])
    const restrictedTools = await restrictedToolsFor(env, rows, {
      teams: new Set(scope.teams),
      products: new Set(scope.products),
      roles: new Set(roleIds)
    })
    // Typed against the shared MCP contract so the serialised shape
    // can't drift from `McpMyContext`.
    const body: McpMyContext = {
      teams: scope.teams,
      products: scope.products,
      accessibleUpstreams: rows.map((r) => r.slug),
      restrictedTools,
      defaultScope: scope
    }
    return jsonResult(body)
  }
})
