/**
 * What one stateless request needs from the server.
 *
 * The stateless lane builds a fresh server for every request. Building the
 * whole surface each time would mean reading the entire upstream catalogue to
 * answer a single `tools/call`, so the factory builds only the part the
 * request addresses. On protocol revision 2026-07-28 the method (and, for a
 * call, the tool name) is in the `Mcp-Method` / `Mcp-Name` headers, which the
 * SDK has already checked against the body — a mismatch is rejected before a
 * handler runs — so they can be trusted as a routing hint. They only ever
 * NARROW what is registered; access is still decided per tool, per caller.
 */

export type RequestFamily =
  /** `server/discover`: instructions + capabilities, nothing registered. */
  | 'discover'
  | 'tools'
  | 'prompts'
  | 'resources'
  /** Unknown or absent method: build everything (the safe default). */
  | 'all'

export interface RequestScope {
  family: RequestFamily
  /** The JSON-RPC method, when the request named one. */
  method: string | null
  /** For `tools/call`: the tool being called. Null means "every tool". */
  toolName: string | null
}

export function requestScope(request: Request | undefined): RequestScope {
  const method = request?.headers.get('mcp-method')?.trim() || null
  if (!method) return { family: 'all', method: null, toolName: null }
  if (method === 'server/discover') return { family: 'discover', method, toolName: null }
  if (method === 'tools/call') {
    const name = request?.headers.get('mcp-name')?.trim() || null
    return { family: 'tools', method, toolName: name }
  }
  if (method.startsWith('tools/')) return { family: 'tools', method, toolName: null }
  if (method.startsWith('prompts/')) return { family: 'prompts', method, toolName: null }
  if (method.startsWith('resources/')) return { family: 'resources', method, toolName: null }
  return { family: 'all', method, toolName: null }
}
