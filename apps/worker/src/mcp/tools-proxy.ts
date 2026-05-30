/**
 * Per-session registry that hydrates proxied upstream tools onto the
 * `McpServer` alongside the built-ins.
 *
 * Lifecycle:
 *   - `init(server)` runs once per session in `McpSessionDO.init()`.
 *     It enumerates upstreams the caller can reach (visibility +
 *     credentials), decrypts each bearer, ensures the catalogue cache
 *     is fresh, and registers one mangled MCP tool per cached
 *     `upstream_tools` row.
 *   - Tool handlers dispatch back through the cached `UpstreamHttpClient`
 *     and surface upstream `tools/call` results as-is.
 *   - `close()` is best-effort; sessions are short-lived and the
 *     workerd isolate frees Client state on its own when the DO dies.
 *
 * Catalogue freshness: a row older than `CATALOGUE_TTL_SECONDS` is
 * refreshed inline on first session encounter — accepted as a one-time
 * connect cost so the agent sees a complete `tools/list` immediately.
 * Empty cache (brand-new upstream) is also refreshed inline.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Env } from '../env'
import {
  countToolsForUpstream,
  getToolsCachedAt,
  getUserCredential,
  listCachedTools,
  listUpstreamsVisibleToUser,
  replaceCachedTools,
  toUpstreamConnection,
  type UpstreamConnection,
  type UpstreamServerRow,
  type UpstreamToolRow
} from '../db/queries/upstreams'
import { listSkillsForUpstream } from '../db/queries/skill-attachments'
import { listDocsForUpstream } from '../db/queries/doc-attachments'
import {
  createUpstreamClient,
  type UpstreamClient
} from '../upstream/upstream-client'
import { resolveUserUpstreamBearer } from '../upstream/bearer'
import { mangleToolName, unmangleToolName } from './tool-name'
import { jsonSchemaToZod } from './json-schema-to-zod'
import { formatUpstreamError, newCorrelationId } from './upstream-error'
import { recordUsage } from '../usage/record'

// 24h cache TTL per docs/plan/C-upstream-proxy.md §C1.
const CATALOGUE_TTL_SECONDS = 24 * 60 * 60

export interface ListUpstreamsEntry {
  slug: string
  displayName: string
  transport: 'streamable_http' | 'sse'
  connected: boolean
  toolsCount: number
  requiresAuth?: 'user_bearer' | 'shared_bearer' | 'user_oauth' | 'none'
  // M7a: whole-upstream attachments (tool_name='' rows in
  // skill_attachments / doc_attachments). Per-tool attachments surface
  // on /api/upstreams/:id/tools instead. Default empty arrays so MCP
  // clients can rely on the field being present.
  attached_skills: Array<{ slug: string; title: string }>
  // `id` is the canonical doc id `get_doc` expects; `slug` is the
  // human-friendly handle. Both are emitted so the discovery chain
  // (list_upstreams → get_doc) works without a second lookup.
  attached_docs: Array<{ id: string; slug: string; title: string }>
}

export class UpstreamProxyRegistry {
  /** upstream_id → live MCP Client */
  private clients = new Map<string, UpstreamClient>()

  constructor(
    private readonly env: Env,
    private readonly userId: string,
    private readonly waitUntil: (p: Promise<unknown>) => void,
    private readonly sessionId: string
  ) {}

  /**
   * Hydrate the registry and register one MCP tool per cached upstream
   * tool. Safe to call before any built-in tools are registered — the
   * SDK accumulates handlers across calls and the eventual `tools/list`
   * returns the union.
   */
  async init(server: McpServer): Promise<void> {
    const rows = await listUpstreamsVisibleToUser(this.env, this.userId)
    for (const row of rows) {
      const conn = safeConnection(row)
      if (!conn) continue
      const bearer = await this.resolveBearer(row, conn)
      if (conn.authStrategy !== 'none' && bearer === null) continue

      const client = createUpstreamClient(conn, bearer)
      const tools = await this.ensureCatalogue(conn, client)
      if (tools.length === 0) {
        // Empty even after refresh — log and skip; user sees built-ins only.
        console.warn(`upstream ${conn.slug} returned no tools after refresh`)
        await client.close()
        continue
      }
      this.clients.set(conn.id, client)
      for (const t of tools) this.registerTool(server, conn, t)
    }
  }

  async close(): Promise<void> {
    const all = [...this.clients.values()]
    this.clients.clear()
    await Promise.all(all.map((c) => c.close()))
  }

  /**
   * Slug-only view of the caller's reachable upstreams. Powers the
   * `list_my_context.accessibleUpstreams` built-in result.
   */
  static async accessibleSlugs(env: Env, userId: string): Promise<string[]> {
    const rows = await listUpstreamsVisibleToUser(env, userId)
    return rows.map((r) => r.slug)
  }

  /**
   * Hydrate rows for the `list_upstreams()` built-in. Reports cached
   * tool count + connected state without forcing a connect. Disconnected
   * upstreams (missing user_bearer creds) are returned with `connected:
   * false` so agents know the deep-link to /upstreams.
   */
  static async listUpstreamsForUser(
    env: Env,
    userId: string
  ): Promise<ListUpstreamsEntry[]> {
    const rows = await listUpstreamsVisibleToUser(env, userId)
    if (rows.length === 0) return []
    const out: ListUpstreamsEntry[] = []
    for (const row of rows) {
      if (row.transport !== 'streamable_http' && row.transport !== 'sse') continue
      const requiresCred =
        row.auth_strategy === 'user_bearer' || row.auth_strategy === 'user_oauth'
      const connected = requiresCred
        ? !!(await getUserCredential(env, userId, row.id))
        : true
      const toolsCount = await countToolsForUpstream(env, row.id)
      // Whole-upstream attachments only (tool_name = ''); per-tool
      // attachments surface via /api/upstreams/:id/tools.
      const [skillAtt, docAtt] = await Promise.all([
        listSkillsForUpstream(env, row.id),
        listDocsForUpstream(env, row.id)
      ])
      const attached_skills = skillAtt
        .filter((s) => s.tool_name === '')
        .map((s) => ({ slug: s.slug, title: s.title }))
      const attached_docs = docAtt
        .filter((d) => d.tool_name === '')
        .map((d) => ({ id: d.doc_id, slug: d.slug, title: d.title }))
      out.push({
        slug: row.slug,
        displayName: row.display_name,
        transport: row.transport,
        connected,
        toolsCount,
        requiresAuth: row.auth_strategy,
        attached_skills,
        attached_docs
      })
    }
    return out
  }

  // ----- internals ------------------------------------------------------

  private resolveBearer(
    row: UpstreamServerRow,
    conn: UpstreamConnection
  ): Promise<string | null> {
    return resolveUserUpstreamBearer(this.env, row, conn, this.userId)
  }

  private async ensureCatalogue(
    conn: UpstreamConnection,
    client: UpstreamClient
  ): Promise<UpstreamToolRow[]> {
    const cachedAt = await getToolsCachedAt(this.env, conn.id)
    const stale =
      cachedAt === null || Date.now() / 1000 - cachedAt > CATALOGUE_TTL_SECONDS
    if (!stale) return listCachedTools(this.env, conn.id)
    try {
      // Reuse the persistent client this registry already opened — avoids
      // a second handshake just to fetch the catalogue.
      const tools = await client.listTools()
      await replaceCachedTools(this.env, conn.id, tools)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[catalogue] ${conn.slug}: tools/list failed: ${msg}`)
      // Fall back to whatever cache we have, even if stale.
    }
    return listCachedTools(this.env, conn.id)
  }

  private registerTool(
    server: McpServer,
    conn: UpstreamConnection,
    row: UpstreamToolRow
  ): void {
    const mangled = mangleToolName(conn.slug, row.tool_name)
    // Upstream-supplied descriptions are untrusted model input. Strip
    // control characters (which can hide injected instructions or
    // disrupt agent rendering) before forwarding. We deliberately do
    // NOT try to detect prompt-injection content — that's the model's
    // job; ours is to keep the wire bytes well-formed.
    const description = truncateDescription(
      sanitizeUntrustedText(`[${conn.displayName}] ${row.description ?? ''}`)
    )
    let inputSchemaJson: unknown = {}
    try {
      inputSchemaJson = JSON.parse(row.input_schema)
    } catch {
      // Bad cache row; treat as no schema. Tool still callable.
    }
    const converted = jsonSchemaToZod(inputSchemaJson)
    const inputSchema = converted.shape ?? converted.zod
    // Close over the real upstream tool name from the cache row. The
    // mangled name we expose to the agent can drop the redundant
    // `${slug}-` prefix (see `mangleToolName`), so `unmangleToolName`
    // would no longer round-trip — we rely on `row.tool_name` here
    // instead. Sanity-check the mangled name shape only.
    const upstreamToolName = row.tool_name
    const handler = async (args: unknown) => {
      if (!unmangleToolName(mangled)) return errText(`bad tool name: ${mangled}`)
      const client = this.clients.get(conn.id)
      if (!client) return errText(`upstream ${conn.slug} not connected`)
      const t0 = Date.now()
      const reqJson = safeJson(args)
      let status: 'ok' | 'error' | 'timeout' = 'ok'
      let respJson = ''
      try {
        const result = await client.callTool(upstreamToolName, args)
        respJson = safeJson(result.content ?? null)
        if (result.isError) status = 'error'
        return {
          isError: !!result.isError,
          content: Array.isArray(result.content)
            ? (result.content as { type: string }[])
            : [{ type: 'text', text: JSON.stringify(result.content ?? null, null, 2) }],
          structuredContent: result.structuredContent as Record<string, unknown> | undefined
        }
      } catch (err) {
        status = isTimeoutError(err) ? 'timeout' : 'error'
        const msg = stringifyError(err)
        respJson = msg
        // Don't echo the raw upstream error verbatim — it can carry
        // API keys, internal hostnames, or stack frames. Sanitise via
        // `formatUpstreamError` (URL/Bearer/IP/stack-frame strip +
        // 200-char cap) and tag with a correlation id so admins can
        // grep the full server-side log when an operator asks.
        const refId = newCorrelationId()
        console.error(
          `[upstream-proxy] [ref=${refId}] ${conn.slug}.${upstreamToolName} ${status}: ${msg}`
        )
        const { userMessage } = formatUpstreamError({
          slug: conn.slug,
          toolName: upstreamToolName,
          status,
          rawMessage: msg,
          refId
        })
        return errText(userMessage)
      } finally {
        recordUsage(
          this.env,
          { waitUntil: this.waitUntil },
          {
            userId: this.userId,
            sessionId: this.sessionId,
            upstreamId: conn.id,
            tool: mangled,
            reqJson,
            respJson,
            latencyMs: Date.now() - t0,
            status
          }
        )
      }
    }
    // The SDK's `registerTool` overload requires a Zod schema at the
    // type level but happily accepts our derived shape at runtime.
    // Single cast on the call keeps the handler closed-over types
    // intact (alternative: cast the inputSchema to `never`, which
    // collapses the callback signature to `() => ...`).
    ;(server.registerTool as unknown as (
      name: string,
      cfg: { title: string; description: string; inputSchema: unknown },
      cb: (args: unknown) => unknown
    ) => unknown)(
      mangled,
      // title = mangled so the human-facing label matches the
      // agent-callable name (and surfaces the upstream slug). Falls
      // out of the same `<slug>__<tool>` rule the admin upstreams
      // page's "Agent-visible name" column uses, after the redundant-
      // prefix collapse (`notion__search`, not `notion__notion-search`).
      { title: mangled, description, inputSchema },
      handler
    )
  }
}

function safeConnection(row: UpstreamServerRow): UpstreamConnection | null {
  try {
    return toUpstreamConnection(row)
  } catch {
    return null
  }
}

function truncateDescription(s: string): string {
  return s.length > 1024 ? s.slice(0, 1023) + '…' : s
}

/**
 * Strip C0 control characters (except tab/newline/carriage return) and
 * the C1 range from an untrusted string before we hand it to the model
 * or echo it back over the wire. Keeps regular punctuation, whitespace,
 * and Unicode intact.
 */
function sanitizeUntrustedText(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '')
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

function isTimeoutError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  // Both the upstream/http-client 60s wall cap and the MCP SDK's
  // own RequestTimeoutError surface as messages mentioning timeout.
  return /timeout|timed out|deadline/i.test(msg)
}

function safeJson(v: unknown): string {
  try {
    return typeof v === 'string' ? v : JSON.stringify(v ?? null)
  } catch {
    return ''
  }
}

function errText(msg: string) {
  return { isError: true, content: [{ type: 'text' as const, text: msg }] }
}
