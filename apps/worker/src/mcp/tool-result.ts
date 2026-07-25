/**
 * The two shapes every MCP tool handler in this folder needs, in one place.
 *
 * `errText` and `safeJson` were byte-identical copies in `session-do.ts`,
 * `tools-proxy.ts`, and `skill-mcp.ts`. They are the wire contract for a tool
 * result, so three copies is three chances for one of them to drift.
 */

/**
 * A failed tool call in MCP's own shape. The message must already be safe to
 * show the agent — upstream text goes through `mcp/upstream-error.ts` first.
 */
export function errText(msg: string) {
  return { isError: true, content: [{ type: 'text' as const, text: msg }] }
}

/**
 * Best-effort JSON for usage accounting. Strings pass through as-is; anything
 * unserialisable (a cycle, a BigInt) degrades to '' rather than throwing —
 * a metrics failure must never fail the tool call it is measuring.
 */
export function safeJson(v: unknown): string {
  try {
    return typeof v === 'string' ? v : JSON.stringify(v ?? null)
  } catch {
    return ''
  }
}
