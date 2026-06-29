import { z } from 'zod'
import { McpUpstreamEntry } from './mcp-types'
import { BuiltinTool } from './builtin-tools'

/**
 * Contract for `GET /api/tools` — the user-facing tools directory feed
 * (`/app/tools`). Surfaces the org's built-in tools + every visible
 * upstream's cached tools grouped by family, by their NATIVE names.
 *
 * Unlike the agent-facing `describe_upstream` (which HIDES ACL-locked
 * tools), the human directory SHOWS them with `restricted: true` + the
 * role/team/product DISPLAY NAMES that would unlock them, so the SPA can
 * render a "Restricted — requires X" badge. This mirrors the existing
 * `list_my_context.restrictedTools` advisory: display names are not secret,
 * and the tool set is already scoped to upstreams the caller can see.
 */

export const ToolsDirectoryTool = z.object({
  // Native upstream tool name, verbatim (e.g. "wit_work_item").
  name: z.string(),
  // The agent-callable mangled name (e.g. "up-ado__wit_work_item").
  call: z.string(),
  // Sanitized one-line gloss of the tool's description; may be ''.
  summary: z.string(),
  // True when per-tool ACL locks this tool against the caller.
  restricted: z.boolean(),
  // Present only when restricted: the principal DISPLAY NAMES (not IDs) that
  // would unlock it. Any of the arrays may be empty.
  requires: z
    .object({
      roles: z.array(z.string()),
      teams: z.array(z.string()),
      products: z.array(z.string())
    })
    .optional()
})
export type ToolsDirectoryTool = z.infer<typeof ToolsDirectoryTool>

/** A family group (first-underscore prefix; '' = ungrouped/self-describing, sorts last). */
export const ToolsDirectoryGroup = z.object({
  family: z.string(),
  tools: z.array(ToolsDirectoryTool)
})
export type ToolsDirectoryGroup = z.infer<typeof ToolsDirectoryGroup>

/**
 * One upstream section: the `list_upstreams` header (connection state,
 * raw cached `toolsCount`, whole-upstream attachments) plus its grouped
 * tools. `toolsCount` is the RAW cached count (locked tools included) —
 * it equals the number of rendered rows, since the directory shows locked.
 *
 * `id` is the internal upstream id (same one `GET /api/upstreams` already
 * returns to this user) — the SPA uses it to lazy-fetch per-tool detail
 * (input schema + per-tool attachments) from `GET /api/upstreams/:id/tools`.
 */
export const ToolsDirectoryUpstream = McpUpstreamEntry.extend({
  id: z.string(),
  groups: z.array(ToolsDirectoryGroup)
})
export type ToolsDirectoryUpstream = z.infer<typeof ToolsDirectoryUpstream>

export const ToolsDirectory = z.object({
  builtins: z.array(BuiltinTool),
  upstreams: z.array(ToolsDirectoryUpstream)
})
export type ToolsDirectory = z.infer<typeof ToolsDirectory>
