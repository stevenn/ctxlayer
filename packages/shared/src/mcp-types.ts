import { z } from 'zod'
import { AuthStrategy } from './upstream-auth-strategy'
import { SupportedTransport } from './upstream-api'

// ---- MCP built-in tool output contracts ----------------------------------
// These are the exact shapes the MCP server serialises from
// `mcp/session-do.ts` + `mcp/tools-proxy.ts`. The worker producers are typed
// against them (compile-time) so the agent-facing wire contract can't silently
// drift from the schema an external MCP client would rely on.

export const McpAttachedSkillRef = z.object({ slug: z.string(), title: z.string() })
export type McpAttachedSkillRef = z.infer<typeof McpAttachedSkillRef>

export const McpAttachedDocRef = z.object({
  // `id` is the canonical handle `get_doc` expects; `slug` is human-friendly.
  id: z.string(),
  slug: z.string(),
  title: z.string()
})
export type McpAttachedDocRef = z.infer<typeof McpAttachedDocRef>

/** One entry from `list_upstreams`. */
export const McpUpstreamEntry = z.object({
  slug: z.string(),
  displayName: z.string(),
  transport: SupportedTransport,
  connected: z.boolean(),
  // Set when a stored user_oauth credential exists but its automatic refresh
  // failed — the upstream is connected-on-paper but its tools won't load until
  // the user reconnects at /upstreams. Absent/false means healthy.
  needsReauth: z.boolean().optional(),
  toolsCount: z.number(),
  requiresAuth: AuthStrategy.optional(),
  // Whole-upstream attachments (curated playbooks / reference docs). Always
  // present (default empty) so clients can rely on the field.
  attached_skills: z.array(McpAttachedSkillRef),
  attached_docs: z.array(McpAttachedDocRef)
})
export type McpUpstreamEntry = z.infer<typeof McpUpstreamEntry>

export const McpListUpstreamsResult = z.array(McpUpstreamEntry)
export type McpListUpstreamsResult = z.infer<typeof McpListUpstreamsResult>

// ---- describe_upstream: one upstream's tools by their native names --------
// `list_upstreams` reports a tool COUNT only; `describe_upstream(slug)` is the
// lazy drill-in that surfaces the actual tools BY THEIR NATIVE upstream names,
// grouped by the upstream's own first-underscore family prefix, each with its
// callable mangled `<slug>__<tool>` name + a one-line summary. Cache-only (no
// upstream dial), ACL-filtered to what the caller can actually call.

/** One tool in `describe_upstream`. */
export const McpUpstreamToolEntry = z.object({
  // Native upstream tool name, verbatim (e.g. "wit_work_item").
  name: z.string(),
  // The agent-callable mangled name (e.g. "up-ado__wit_work_item").
  call: z.string(),
  // Sanitized one-line gloss of the tool's description; may be ''.
  summary: z.string()
})
export type McpUpstreamToolEntry = z.infer<typeof McpUpstreamToolEntry>

/** A family group in `describe_upstream`. */
export const McpUpstreamToolGroup = z.object({
  // First-underscore prefix of the (slug-collapsed) tool name. '' = no prefix;
  // the name is self-describing and the tool is ungrouped.
  family: z.string(),
  tools: z.array(McpUpstreamToolEntry)
})
export type McpUpstreamToolGroup = z.infer<typeof McpUpstreamToolGroup>

/** `describe_upstream` result. */
export const McpUpstreamTools = z.object({
  slug: z.string(),
  displayName: z.string(),
  // Count of tools VISIBLE TO YOU (after per-tool ACL). May be smaller than
  // `list_upstreams.toolsCount`, which is the raw cached count.
  toolsCount: z.number(),
  groups: z.array(McpUpstreamToolGroup)
})
export type McpUpstreamTools = z.infer<typeof McpUpstreamTools>

/** One attachment pointer on a skill (from `list_skills`). */
export const McpSkillAttachment = z.object({
  upstream_slug: z.string(),
  tool_name: z.string().nullable()
})
export type McpSkillAttachment = z.infer<typeof McpSkillAttachment>

/** One entry from `list_skills`. */
export const McpSkillSummary = z.object({
  slug: z.string(),
  name: z.string(),
  title: z.string(),
  description: z.string(),
  attached_to: z.array(McpSkillAttachment)
})
export type McpSkillSummary = z.infer<typeof McpSkillSummary>

export const McpListSkillsResult = z.array(McpSkillSummary)
export type McpListSkillsResult = z.infer<typeof McpListSkillsResult>

/**
 * One entry in `list_my_context.restrictedTools`: a tool the caller can
 * see the upstream for but is NOT allowed to call (it's locked to other
 * principals). `requires` lists the role/team/product ids that WOULD
 * grant it, so the agent can tell the user what access to request rather
 * than hitting a blank "tool not found". The tool is hidden from
 * tools/list — this advisory is its only signal it exists.
 */
export const McpRestrictedTool = z.object({
  upstream: z.string(),
  tool: z.string(),
  requires: z.object({
    roles: z.array(z.string()),
    teams: z.array(z.string()),
    products: z.array(z.string())
  })
})
export type McpRestrictedTool = z.infer<typeof McpRestrictedTool>

/**
 * `list_my_context` result. Every array holds ids/slugs (not objects):
 * `teams`/`products`/`defaultScope.*` are ids; `accessibleUpstreams` are
 * slugs. Mirrors `resolveUserScope` + `accessibleSlugs` in the worker.
 */
export const McpMyContext = z.object({
  teams: z.array(z.string()),
  products: z.array(z.string()),
  accessibleUpstreams: z.array(z.string()),
  // Tools hidden from the caller by per-tool ACL, with what would unlock
  // them. Empty when nothing the caller can see is locked against them.
  restrictedTools: z.array(McpRestrictedTool),
  defaultScope: z.object({
    teams: z.array(z.string()),
    products: z.array(z.string())
  })
})
export type McpMyContext = z.infer<typeof McpMyContext>
