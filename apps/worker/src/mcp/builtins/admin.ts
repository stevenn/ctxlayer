import { McpActiveUsers } from '@ctxlayer/shared'
import { activeUsers, parseActiveUsersWindow } from '../../db/queries/usage-read'
import { BUILTIN_INPUT_SHAPES } from '../builtin-schemas'
import { errText } from '../tool-result'
import { defineBuiltin, jsonResult } from './types'

/** `active_users` — who used the gateway recently. Admin-only data. */
export const activeUsersTool = defineBuiltin({
  name: 'active_users',
  inputShape: BUILTIN_INPUT_SHAPES.active_users,
  outputShape: McpActiveUsers.shape,
  run: async (args, { env, user }) => {
    // Reads org-wide activity incl. colleagues' emails — admin-gated
    // (mirrors the admin-only `topUsers` usage query). The tool still
    // lists in /app/tools for everyone; only admins get data.
    if (user?.role !== 'admin') return errText('admin_only')
    const windowSeconds = parseActiveUsersWindow(args.window)
    const { since, count, users } = await activeUsers(env, windowSeconds)
    const body: McpActiveUsers = { windowSeconds, since, activeUserCount: count, users }
    return jsonResult(body)
  }
})
