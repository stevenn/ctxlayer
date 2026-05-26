/**
 * `${slug}__${tool}` namespacing for proxied upstream tools.
 *
 * `__` inside an upstream tool name is reserved as the delimiter; we
 * escape it to `_~_` on the way in so a tool literally called
 * `foo__bar` would surface as `slug__foo_~_bar`. `~` is not a legal
 * MCP tool-name character outside this escape, so the inverse is
 * unambiguous.
 *
 * **Slug-prefix collapse**: many upstreams namespace their own tools
 * with their own slug (e.g. Notion ships `notion-search`,
 * `notion-fetch`). Without intervention this lands as the ugly
 * `notion__notion-search`. We collapse the redundant prefix by
 * stripping `${slug}-` (or `${slug}_`) from the upstream tool name
 * before mangling, so the surfaced name is `notion__search`.
 *
 * That makes the visible name asymmetric with the real upstream tool
 * name — the dispatch site MUST use the original `upstream_tools.tool_name`
 * from D1 when calling the upstream Client, not the result of
 * `unmangleToolName`. `unmangleToolName` is kept only as a sanity
 * check (and for diagnostic strings).
 *
 * See docs/plan/C-upstream-proxy.md §C2 for the edge-case matrix.
 */
const DELIMITER = '__'
const ESCAPED = '_~_'

export function mangleToolName(slug: string, toolName: string): string {
  const collapsed = collapseSlugPrefix(slug, toolName)
  return `${slug}${DELIMITER}${collapsed.replaceAll(DELIMITER, ESCAPED)}`
}

export interface UnmangledTool {
  slug: string
  toolName: string
}

export function unmangleToolName(mangled: string): UnmangledTool | null {
  const i = mangled.indexOf(DELIMITER)
  if (i <= 0 || i + DELIMITER.length >= mangled.length) return null
  const slug = mangled.slice(0, i)
  const tail = mangled.slice(i + DELIMITER.length)
  return { slug, toolName: tail.replaceAll(ESCAPED, DELIMITER) }
}

/**
 * Drop a leading `${slug}-` / `${slug}_` from an upstream tool name so
 * the mangled output doesn't double the prefix. Conservative — only
 * strips when removing it leaves at least one character behind so we
 * never produce `slug__`. Case-insensitive on the slug match so
 * `Notion-Search` is also caught.
 */
export function collapseSlugPrefix(slug: string, toolName: string): string {
  if (!slug) return toolName
  const lowered = toolName.toLowerCase()
  const slugLower = slug.toLowerCase()
  for (const sep of ['-', '_']) {
    const prefix = slugLower + sep
    if (lowered.startsWith(prefix) && toolName.length > prefix.length) {
      return toolName.slice(prefix.length)
    }
  }
  return toolName
}
