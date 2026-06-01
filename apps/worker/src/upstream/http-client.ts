/**
 * Thin wrapper around `@modelcontextprotocol/sdk` Client for HTTP/SSE
 * upstreams. One `UpstreamHttpClient` instance per `(session, upstream)`
 * — lifecycle owned by the per-session registry in `mcp/tools-proxy.ts`.
 *
 * Streamable HTTP is the default; SSE is the fallback for servers that
 * have not migrated yet. Both share the same MCP Client surface.
 *
 * Per-call timeouts are enforced via `RequestOptions` — a base inactivity
 * window plus a hard `maxTotalTimeout` ceiling — which the SDK forwards to
 * its internal `AbortController`. See the constants below.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker-provider.js'
import type { UpstreamConnection } from '../db/queries/upstreams'
import type { UpstreamCallResult, UpstreamCatalogueTool, UpstreamClient } from './upstream-client'

/**
 * tools/list is metadata — keep it on a tight fail-fast cap so a hung
 * upstream can't stall session bootstrap or Refresh-tools.
 */
export const UPSTREAM_LIST_TIMEOUT_MS = 60_000

/**
 * Base per-call inactivity window. Raised from the original flat 60s:
 * some upstream tools (e.g. Driver's `gather_task_context`) advertise
 * 1-3 min runtimes, and a 60s cap timed every one of them out. This is
 * the ceiling for an upstream that goes *silent* (emits no progress).
 */
export const UPSTREAM_CALL_TIMEOUT_MS = 150_000

/**
 * Absolute ceiling regardless of progress. When an upstream DOES stream
 * progress notifications, `resetTimeoutOnProgress` keeps the inactivity
 * window alive on each ping — but a call can never exceed this hard cap.
 */
export const UPSTREAM_MAX_CALL_TIMEOUT_MS = 300_000

/**
 * Hard upper bound on any per-upstream timeout override (see
 * `authConfig.timeouts`). Until the Durable Object request wall-clock
 * ceiling is verified (docs/plan/I-upstream-resilience.md §I9), no
 * upstream may opt into a window longer than the current hard cap. Raise
 * this once that platform number is known — it is the single ceiling the
 * admin REST clamp and the defensive client clamp both reference.
 */
export const UPSTREAM_TIMEOUT_CLAMP_MS = UPSTREAM_MAX_CALL_TIMEOUT_MS

/**
 * Default ceiling on the byte size of a relayed `tools/call` result.
 * Oversized payloads (e.g. Driver's whole-repo `get_code_map` ≈ 1.4 MB)
 * degrade to a structured truncation notice instead of being forwarded
 * verbatim — protecting the agent's context and the usage tokeniser.
 * Overridable per-upstream via `authConfig.maxResponseBytes`.
 */
export const UPSTREAM_MAX_RESPONSE_BYTES = 256 * 1024

const CLIENT_NAME = 'ctxlayer'
const CLIENT_VERSION = '0.1.0'

// `UpstreamCatalogueTool` / `UpstreamCallResult` / `UpstreamClient` now
// live in `upstream-client.ts` (the transport-agnostic surface).
// Re-export the result/catalogue types here so existing importers of
// http-client keep working.
export type { UpstreamCatalogueTool, UpstreamCallResult } from './upstream-client'

export class UpstreamHttpClient implements UpstreamClient {
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

  /**
   * Resolve a per-upstream timeout override, falling back to the module
   * default and defensively clamping to the hard ceiling so a hand-edited
   * DB row can't exceed the platform-safe bound.
   */
  private timeout(override: number | undefined, fallback: number): number {
    const value = override ?? fallback
    return Math.min(value, UPSTREAM_TIMEOUT_CLAMP_MS)
  }

  async listTools(): Promise<UpstreamCatalogueTool[]> {
    const client = await this.ensureConnected()
    const timeout = this.timeout(
      this.upstream.authConfig.timeouts?.listMs,
      UPSTREAM_LIST_TIMEOUT_MS
    )
    const res = await client.listTools(undefined, { timeout })
    return (res.tools ?? []).map((t) => ({
      toolName: t.name,
      description: t.description ?? null,
      inputSchema: t.inputSchema
    }))
  }

  async callTool(name: string, args: unknown): Promise<UpstreamCallResult> {
    const client = await this.ensureConnected()
    const overrides = this.upstream.authConfig.timeouts
    const res = await client.callTool(
      { name, arguments: (args ?? {}) as Record<string, unknown> },
      undefined,
      {
        timeout: this.timeout(overrides?.callMs, UPSTREAM_CALL_TIMEOUT_MS),
        // Passing onprogress makes the SDK request progress notifications
        // (it sends a progressToken); resetTimeoutOnProgress then keeps a
        // long-but-alive call from tripping the inactivity window. The
        // callback body is a no-op — we only want the keep-alive effect.
        onprogress: () => {},
        resetTimeoutOnProgress: true,
        maxTotalTimeout: this.timeout(overrides?.maxCallMs, UPSTREAM_MAX_CALL_TIMEOUT_MS)
      }
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
