import { z } from 'zod'

/**
 * The org's built-in MCP tools — ctxlayer's own surface alongside the
 * proxied upstream tools. SINGLE SOURCE OF TRUTH for:
 *   - the MCP registrations themselves: `session-do.ts` / `skill-mcp.ts`
 *     pull each tool's title + description from here via `builtinToolMeta`,
 *     so what the agent sees and what `/api/tools` lists can never drift;
 *   - the `/api/tools` directory feed (the SPA's built-in list);
 *   - the reserved-slug guard in `upstream-api.ts` (an upstream slug must
 *     not collide with a built-in name).
 *
 * Adding/removing a built-in: add/remove its entry here (the registration
 * site's `builtinToolMeta('<name>')` then resolves it). The
 * `BUILTIN_TOOL_SLUGS` drift test pins the name set as a backstop.
 */
export const BuiltinTool = z.object({
  name: z.string(),
  title: z.string(),
  description: z.string()
})
export type BuiltinTool = z.infer<typeof BuiltinTool>

export const BUILTIN_TOOLS: BuiltinTool[] = [
  {
    name: 'whoami',
    title: 'Who am I?',
    description: 'Returns the user props attached to this MCP session by ctxlayer.'
  },
  {
    name: 'list_my_context',
    title: 'List my context',
    description:
      'Returns the teams + products the caller belongs to (transitively via team membership), the accessible upstream MCP servers, and the reachable team/product scope (used to NARROW search; `search_docs` itself defaults to open-read across all docs).'
  },
  {
    name: 'list_upstreams',
    title: 'List upstreams',
    description:
      'Lists the upstream MCP servers visible to the caller, with connected state, transport, and cached tool count. Disconnected upstreams point the user at /upstreams to paste a token.'
  },
  {
    name: 'describe_upstream',
    title: 'Describe an upstream',
    description:
      "Lists one upstream's tools by their native upstream names, grouped by family prefix, each with its callable <slug>__<tool> name and a one-line summary. Read-only, from the cached catalogue. Use when an upstream's mangled tool names are opaque and you need to see what it can do before calling. Optional `family` / `query` narrow the result."
  },
  {
    name: 'reload_upstreams',
    title: 'Reload upstreams',
    description:
      'Re-scans your upstream MCP servers and registers the tools of any upstream connected AFTER this session started (ctxlayer binds upstream tools at session init, so a mid-session connect is otherwise invisible). Emits tools/list_changed so a client that honors it surfaces the new tools without reconnecting. Call this after connecting a new upstream in /app/upstreams if its tools list but are not yet callable.'
  },
  {
    name: 'get_doc',
    title: 'Get document',
    description: 'Returns the markdown for a doc by id or slug.'
  },
  {
    name: 'search_docs',
    title: 'Search docs',
    description:
      'Semantic search over the org-curated doc library. Open-read: searches ALL docs by default (docs are readable org-wide; tags narrow, they do not hide). Pass `scope: { teams: [...], products: [...] }` to narrow to docs carrying those team/product tags (intersected with the caller\'s reachable set, no escalation). `scope: "all"` is the explicit form of the default.'
  },
  {
    name: 'list_skills',
    title: 'List skills',
    description:
      'Lists org-curated skills (procedural playbooks the agent can load on demand). Each entry carries the SKILL.md `name`, a one-line `description` (when to invoke), and the upstream tools it is attached to. Only published skills surface.'
  },
  {
    name: 'get_skill',
    title: 'Get skill',
    description: 'Fetches a skill body by slug. Returns SKILL.md frontmatter + body in markdown.'
  }
]

/** Built-in tool names — the reserved set an upstream slug must not collide with. */
export const BUILTIN_TOOL_SLUGS: string[] = BUILTIN_TOOLS.map((t) => t.name)

const BUILTIN_BY_NAME = new Map(BUILTIN_TOOLS.map((t) => [t.name, t]))

/**
 * The `{ title, description }` for a built-in tool, for the MCP registration
 * sites to spread into their `registerTool` config (alongside any
 * input/output schema). Throws on an unknown name so a registration can't
 * silently reference a tool that isn't catalogued.
 */
export function builtinToolMeta(name: string): { title: string; description: string } {
  const t = BUILTIN_BY_NAME.get(name)
  if (!t) throw new Error(`unknown built-in tool: ${name}`)
  return { title: t.title, description: t.description }
}
