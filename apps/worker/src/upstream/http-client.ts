/**
 * Thin wrapper around `@modelcontextprotocol/sdk` Client for HTTP/SSE
 * upstreams. One `UpstreamHttpClient` instance per `(session, upstream)`
 * — lifecycle owned by the per-session registry in `mcp/tools-proxy.ts`.
 *
 * Streamable HTTP is the default; SSE is the fallback for servers that
 * have not migrated yet. Both share the same MCP Client surface.
 *
 * Per-request 60s wall cap is enforced via `RequestOptions.timeout`,
 * which the SDK forwards to its internal `AbortController`.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker-provider.js'
import type { UpstreamConnection } from '../db/queries/upstreams'

export const UPSTREAM_CALL_TIMEOUT_MS = 60_000
const CLIENT_NAME = 'ctxlayer'
const CLIENT_VERSION = '0.1.0'

export interface UpstreamCatalogueTool {
  toolName: string
  description: string | null
  inputSchema: unknown
}

export interface UpstreamCallResult {
  content: unknown
  isError?: boolean
  structuredContent?: unknown
}

export class UpstreamHttpClient {
  private client: Client | null = null
  private connecting: Promise<Client> | null = null

  constructor(
    readonly upstream: UpstreamConnection,
    private readonly bearerToken: string | null
  ) {}

  private headers(): Record<string, string> {
    const cfg = this.upstream.authConfig.http
    const headerName = cfg?.headerName ?? 'Authorization'
    const headerPrefix = cfg?.headerPrefix ?? 'Bearer '
    const out: Record<string, string> = {}
    if (this.bearerToken) {
      out[headerName] = `${headerPrefix}${this.bearerToken}`
    }
    return out
  }

  private async ensureConnected(): Promise<Client> {
    if (this.client) return this.client
    if (this.connecting) return this.connecting
    this.connecting = (async () => {
      const url = new URL(this.upstream.url)
      const requestInit: RequestInit = { headers: this.headers() }
      const transport =
        this.upstream.transport === 'sse'
          ? new SSEClientTransport(url, { requestInit })
          : new StreamableHTTPClientTransport(url, { requestInit })
      const client = new Client(
        { name: CLIENT_NAME, version: CLIENT_VERSION },
        {
          capabilities: {},
          // AJV (the SDK default) compiles JSON Schema via `new Function`,
          // which Workers blocks. cacheToolMetadata() runs after every
          // listTools(), so Refresh-tools dies before returning unless we
          // swap in the cfworker-backed validator.
          jsonSchemaValidator: new CfWorkerJsonSchemaValidator()
        }
      )
      await client.connect(transport)
      this.client = client
      return client
    })()
    try {
      return await this.connecting
    } finally {
      this.connecting = null
    }
  }

  async listTools(): Promise<UpstreamCatalogueTool[]> {
    const client = await this.ensureConnected()
    const res = await client.listTools(undefined, { timeout: UPSTREAM_CALL_TIMEOUT_MS })
    return (res.tools ?? []).map((t) => ({
      toolName: t.name,
      description: t.description ?? null,
      inputSchema: t.inputSchema
    }))
  }

  async callTool(name: string, args: unknown): Promise<UpstreamCallResult> {
    const client = await this.ensureConnected()
    const res = await client.callTool(
      { name, arguments: (args ?? {}) as Record<string, unknown> },
      undefined,
      { timeout: UPSTREAM_CALL_TIMEOUT_MS }
    )
    return {
      content: res.content,
      isError: res.isError as boolean | undefined,
      structuredContent: res.structuredContent
    }
  }

  async close(): Promise<void> {
    const client = this.client
    this.client = null
    if (client) {
      try {
        await client.close()
      } catch {
        // Best-effort; the session is going away regardless.
      }
    }
  }
}
