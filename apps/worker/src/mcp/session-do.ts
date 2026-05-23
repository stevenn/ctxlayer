import { DurableObject } from 'cloudflare:workers'
import type { Env } from '../env'

/**
 * Per-session MCP server state. In M2 this extends McpAgent from the
 * Cloudflare `agents` SDK, holds the upstream client map, and dispatches
 * JSON-RPC. For now it's a stub so wrangler can bind the class.
 */
export class McpSessionDO extends DurableObject<Env> {
  override async fetch(req: Request): Promise<Response> {
    return new Response('McpSessionDO not yet implemented', { status: 501 })
  }
}
