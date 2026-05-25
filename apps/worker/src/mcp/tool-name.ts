/**
 * `${slug}__${tool}` namespacing for proxied upstream tools.
 *
 * `__` inside an upstream tool name is reserved as the delimiter; we
 * escape it to `_~_` on the way in and reverse on dispatch so a tool
 * literally called `foo__bar` would surface as `slug__foo_~_bar` and
 * still round-trip cleanly. `~` is not a legal MCP tool-name character
 * outside this escape, so the inverse is unambiguous.
 *
 * See docs/plan/C-upstream-proxy.md §C2 for the edge-case matrix.
 */
const DELIMITER = '__'
const ESCAPED = '_~_'

export function mangleToolName(slug: string, toolName: string): string {
  return `${slug}${DELIMITER}${toolName.replaceAll(DELIMITER, ESCAPED)}`
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
