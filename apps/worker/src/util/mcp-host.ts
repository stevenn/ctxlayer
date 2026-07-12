/**
 * Host-scoping for the machine MCP surface.
 *
 * When a deployment runs a dedicated MCP host (MCP_PUBLIC_URL — e.g. behind
 * Cloudflare Access, where the browser host is fully gated and unusable by
 * machine clients), the bearer-gated MCP endpoints belong ONLY on that host.
 * They are still *served* on the browser host by the same Worker, where a user
 * with a valid Access session reaches them and gets a confusing
 * `invalid_token` (they're past Access but have no MCP bearer). Returning 404
 * there instead removes that confusion — the canonical answer is "this endpoint
 * lives on the MCP host."
 *
 * No-op unless MCP_PUBLIC_URL is set: single-host deployments serve MCP on their
 * one host as before.
 */

import type { Env } from '../env'

function hostOf(url: string): string | null {
  try {
    return new URL(url).host
  } catch {
    return null
  }
}

/** The bearer-gated machine paths (OAuth provider `apiHandlers`). */
function isMcpSurfacePath(pathname: string): boolean {
  return (
    pathname === '/mcp' ||
    pathname.startsWith('/mcp/') ||
    pathname === '/sse' ||
    pathname.startsWith('/sse/')
  )
}

/**
 * True when this request targets an MCP-surface path on a host OTHER than the
 * configured dedicated MCP host — i.e. it should 404 rather than be served.
 */
export function isMcpPathOnWrongHost(req: Request, env: Env): boolean {
  const configured = env.MCP_PUBLIC_URL
  if (!configured) return false
  const mcpHost = hostOf(configured)
  if (!mcpHost) return false
  const url = new URL(req.url)
  if (url.host === mcpHost) return false
  return isMcpSurfacePath(url.pathname)
}
