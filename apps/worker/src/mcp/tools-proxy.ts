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
  listUpstreamsVisibleToUser,
  toUpstreamConnection,
  type UpstreamConnection,
  type UpstreamServerRow
} from '../db/queries/upstreams'
import {
  countToolsForUpstreams,
  listCachedTools,
  listCachedToolsForUpstreams,
  replaceCachedTools,
  type UpstreamToolRow
} from '../db/queries/upstream-tools'
import { getUserCredentialStatuses } from '../db/queries/upstream-credentials'
import { listSkillsForUpstreams, type SkillForUpstreamRow } from '../db/queries/skill-attachments'
import { listDocsForUpstreams, type DocForUpstreamRow } from '../db/queries/doc-attachments'
import { resolveUserScope } from '../db/queries/doc-tags'
import { listUserRoleIds } from '../db/queries/roles'
import {
  accessKey,
  indexToolAccess,
  listToolAccessForUpstreams
} from '../db/queries/tool-access'
import { createUpstreamClient } from '../upstream/create-client'
import { isDialableTransport, type UpstreamClient } from '../upstream/upstream-client'
import {
  isToolAllowed,
  requiresFromRules,
  type McpRestrictedTool,
  type McpUpstreamEntry,
  type SupportedTransport,
  type UserPrincipals
} from '@ctxlayer/shared'
import { resolveUserUpstreamBearer } from '../upstream/bearer'
import { mangleToolName, unmangleToolName } from './tool-name'
import { jsonSchemaToZod } from './json-schema-to-zod'
import { formatUpstreamError, newCorrelationId } from './upstream-error'
import type { RecordUsageArgs } from '../usage/record'
import { byteLength } from '../usage/tokens'
import { UPSTREAM_MAX_RESPONSE_BYTES } from '../upstream/http-client'

// 24h cache TTL per docs/plan/C-upstream-proxy.md §C1.
const CATALOGUE_TTL_SECONDS = 24 * 60 * 60

// The `list_upstreams` entry shape is the shared MCP output contract; the
// builder below is typed against it so it can't drift from the schema.
export type ListUpstreamsEntry = McpUpstreamEntry

/**
 * The visible-upstream rows + their skill/doc attachments for one user,
 * fetched in 3 round trips total (one list + two `IN (...)` batches).
 * Loaded once per session init and shared between `upstreamGuidance`
 * (server instructions) and `init` (tool registration) so neither
 * re-runs the visibility query or the per-upstream attachment reads.
 */
export interface UpstreamUserContext {
  rows: UpstreamServerRow[]
  skillsByUpstream: Map<string, SkillForUpstreamRow[]>
  docsByUpstream: Map<string, DocForUpstreamRow[]>
}

export class UpstreamProxyRegistry {
  /** upstream_id → live MCP Client */
  private clients = new Map<string, UpstreamClient>()
  /**
   * `accessKey(upstream_id, tool_name)` for every tool this session is
   * allowed to call. Populated at `init()` from the per-tool ACL; also
   * backstops the call handler (defense-in-depth).
   */
  private allowedToolKeys = new Set<string>()

  constructor(
    private readonly env: Env,
    private readonly userId: string,
    // Stage a usage event into the owning DO's SQLite outbox. Awaited on
    // the tool path (cheap: one synchronous insert + an idempotent drain
    // schedule) so durability no longer rides a cancellable `waitUntil`.
    private readonly stageUsage: (args: RecordUsageArgs) => Promise<void>,
    private readonly sessionId: string,
    // Injectable so tests can substitute a fake transport without real
    // network. Defaults to the real factory in production.
    private readonly makeClient: typeof createUpstreamClient = createUpstreamClient
  ) {}

  /**
   * The visible upstreams + their attachments for one user, in 3 D1
   * round trips. `McpSessionDO.init()` loads this once and feeds it to
   * both `upstreamGuidance` and `init`.
   */
  static async loadUserContext(env: Env, userId: string): Promise<UpstreamUserContext> {
    const rows = await listUpstreamsVisibleToUser(env, userId)
    const ids = rows.map((r) => r.id)
    const [skillsByUpstream, docsByUpstream] = await Promise.all([
      listSkillsForUpstreams(env, ids),
      listDocsForUpstreams(env, ids)
    ])
    return { rows, skillsByUpstream, docsByUpstream }
  }

  /**
   * Hydrate the registry and register one MCP tool per cached upstream
   * tool. Safe to call before any built-in tools are registered — the
   * SDK accumulates handlers across calls and the eventual `tools/list`
   * returns the union. Accepts the prefetched per-user context from
   * `loadUserContext` (session init shares it with `upstreamGuidance`);
   * loads it itself when not supplied.
   */
  async init(server: McpServer, ctx?: UpstreamUserContext): Promise<void> {
    const { rows, skillsByUpstream, docsByUpstream } =
      ctx ?? (await UpstreamProxyRegistry.loadUserContext(this.env, this.userId))
    if (rows.length === 0) return
    // Resolve the caller's principals + the per-tool ACL + the cached
    // catalogues for every visible upstream once, up front. A tool with
    // no ACL rows inherits the upstream's visibility; a locked tool the
    // caller doesn't match is HIDDEN here (never registered, so the agent
    // never sees it). The allowed-key set also backstops the call handler.
    const [principals, aclRows, cachedByUpstream] = await Promise.all([
      resolveUserPrincipals(this.env, this.userId),
      listToolAccessForUpstreams(
        this.env,
        rows.map((r) => r.id)
      ),
      listCachedToolsForUpstreams(
        this.env,
        rows.map((r) => r.id)
      )
    ])
    const acl = indexToolAccess(aclRows)
    // Per-upstream prep (bearer resolution, client dial, catalogue
    // refresh) runs concurrently; a throw degrades only that upstream.
    // Registration happens sequentially afterwards, in `rows` order, so
    // the tool ordering visible in `tools/list` stays deterministic.
    const prepped = await Promise.all(
      rows.map((row) =>
        this.prepareUpstream(row, cachedByUpstream.get(row.id) ?? []).catch((err) => {
          const msg = err instanceof Error ? err.message : String(err)
          console.error(`[upstream-proxy] ${row.slug}: init failed: ${msg}`)
          return null
        })
      )
    )
    for (const prep of prepped) {
      if (!prep) continue
      const { conn, client, tools } = prep
      this.clients.set(conn.id, client)
      const skills = skillsByUpstream.get(conn.id) ?? []
      const docs = docsByUpstream.get(conn.id) ?? []
      // Two attachment scopes, both surfaced on the tool description so the
      // binding nudge rides in context at call time (not just the easily-
      // skipped server `instructions` tail): whole-upstream playbooks
      // (tool_name = '') fan out onto EVERY tool of this upstream; per-tool
      // pointers (tool_name != '') attach only to their named tool. The
      // server `instructions` still names the whole-upstream ones too
      // (`upstreamGuidance`) — intentional redundancy, the description is
      // the reliable surface.
      const wholeUpstream = wholeUpstreamPointers(skills, docs)
      const perTool = perToolPointers(skills, docs)
      for (const t of tools) {
        const key = accessKey(conn.id, t.tool_name)
        if (!isToolAllowed(acl.get(key), principals)) continue // hidden by ACL
        this.allowedToolKeys.add(key)
        // Whole-upstream first (the general "how we do X here" playbook),
        // then the narrower per-tool pointers; dedup so an attachment that
        // is both scopes isn't named twice.
        const pointers = [...new Set([...wholeUpstream, ...(perTool.get(t.tool_name) ?? [])])]
        this.registerTool(server, conn, t, pointers)
      }
    }
  }

  /**
   * Builds the dynamic tail of the MCP server `instructions`: one line
   * per visible upstream that carries a *whole-upstream* skill/doc
   * attachment (tool_name = ''), naming each so the agent reads the org
   * playbook before its first call. Returns '' when nothing is attached.
   * The slugs are org-curated (kebab-case, first-party) — unlike upstream
   * tool descriptions they are not untrusted input, so no sanitisation.
   * Pure formatting over the prefetched `loadUserContext` data.
   */
  static upstreamGuidance(ctx: UpstreamUserContext): string {
    const lines: string[] = []
    for (const row of ctx.rows) {
      const refs = wholeUpstreamPointers(
        ctx.skillsByUpstream.get(row.id) ?? [],
        ctx.docsByUpstream.get(row.id) ?? []
      )
      if (refs.length > 0) {
        lines.push(`- \`${row.slug}\`: consult ${refs.join(', ')} before using its tools.`)
      }
    }
    if (lines.length === 0) return ''
    return (
      '\n\n**Org playbooks attached to your upstreams — read these BEFORE the ' +
      "first call to the named upstream's tools. They encode required conventions " +
      '(label/status names, formatting rules, prefer-this-tool guidance) the tool ' +
      'schemas do not show:**\n' +
      lines.join('\n')
    )
  }

  async close(): Promise<void> {
    const all = [...this.clients.values()]
    this.clients.clear()
    await Promise.all(all.map((c) => c.close()))
  }

  /**
   * Tools hidden from the caller by per-tool ACL, with what would unlock
   * each. Powers `list_my_context.restrictedTools` — the discoverability
   * signal that lets the agent say "that tool needs role X" instead of
   * hitting a blank "tool not found". Scoped to upstreams the caller can
   * already SEE (we never reveal a tool on an upstream they can't see).
   * Reads the cached catalogue (no refresh) — best-effort advisory.
   * Takes the caller's visible rows + principals from the caller (the
   * `list_my_context` handler already holds both), and only reads the
   * catalogues of upstreams that actually carry ACL rows — often zero.
   */
  static async restrictedToolsFor(
    env: Env,
    rows: UpstreamServerRow[],
    principals: UserPrincipals
  ): Promise<McpRestrictedTool[]> {
    const dialable = rows.filter((r) => isDialableTransport(r.transport))
    if (dialable.length === 0) return []
    const aclRows = await listToolAccessForUpstreams(
      env,
      dialable.map((r) => r.id)
    )
    if (aclRows.length === 0) return []
    const acl = indexToolAccess(aclRows)
    // Only upstreams with ACL rows can produce restricted tools; skip the
    // catalogue read for the (common) unrestricted rest.
    const aclUpstreamIds = new Set(aclRows.map((r) => r.upstream_id))
    const toolsByUpstream = await listCachedToolsForUpstreams(env, [...aclUpstreamIds])
    const out: McpRestrictedTool[] = []
    for (const row of dialable) {
      const tools = toolsByUpstream.get(row.id) ?? []
      for (const t of tools) {
        const rules = acl.get(accessKey(row.id, t.tool_name))
        if (!rules || rules.length === 0) continue // open / inherit
        if (isToolAllowed(rules, principals)) continue // caller can call it
        out.push({ upstream: row.slug, tool: t.tool_name, requires: requiresFromRules(rules) })
      }
    }
    return out
  }

  /**
   * Hydrate rows for the `list_upstreams()` built-in. Reports cached
   * tool count + connected state without forcing a connect. Disconnected
   * upstreams (missing user_bearer creds) are returned with `connected:
   * false` so agents know the deep-link to /upstreams.
   */
  static async listUpstreamsForUser(env: Env, userId: string): Promise<ListUpstreamsEntry[]> {
    const rows = (await listUpstreamsVisibleToUser(env, userId)).filter(
      (r): r is UpstreamServerRow & { transport: SupportedTransport } =>
        isDialableTransport(r.transport)
    )
    if (rows.length === 0) return []
    const ids = rows.map((r) => r.id)
    const credIds = rows
      .filter((r) => r.auth_strategy === 'user_bearer' || r.auth_strategy === 'user_oauth')
      .map((r) => r.id)
    const [credStatuses, toolCounts, skillsByUpstream, docsByUpstream] = await Promise.all([
      getUserCredentialStatuses(env, userId, credIds),
      countToolsForUpstreams(env, ids),
      listSkillsForUpstreams(env, ids),
      listDocsForUpstreams(env, ids)
    ])
    return rows.map((row) => {
      const requiresCred = row.auth_strategy === 'user_bearer' || row.auth_strategy === 'user_oauth'
      const cred = requiresCred
        ? (credStatuses.get(row.id) ?? { present: false, needsReauth: false })
        : { present: true, needsReauth: false }
      // Whole-upstream attachments only (tool_name = ''); per-tool
      // attachments surface via /api/upstreams/:id/tools.
      const attached_skills = (skillsByUpstream.get(row.id) ?? [])
        .filter((s) => s.tool_name === '')
        .map((s) => ({ slug: s.slug, title: s.title }))
      const attached_docs = (docsByUpstream.get(row.id) ?? [])
        .filter((d) => d.tool_name === '')
        .map((d) => ({ id: d.doc_id, slug: d.slug, title: d.title }))
      return {
        slug: row.slug,
        displayName: row.display_name,
        transport: row.transport,
        connected: cred.present,
        ...(cred.needsReauth ? { needsReauth: true } : {}),
        toolsCount: toolCounts.get(row.id) ?? 0,
        requiresAuth: row.auth_strategy,
        attached_skills,
        attached_docs
      }
    })
  }

  // ----- internals ------------------------------------------------------

  private resolveBearer(row: UpstreamServerRow, conn: UpstreamConnection): Promise<string | null> {
    return resolveUserUpstreamBearer(this.env, row, conn, this.userId)
  }

  /**
   * Resolve credentials, dial the upstream, and ensure its catalogue is
   * fresh. Returns null to skip the upstream (bad row, missing creds,
   * empty catalogue); throws propagate to the per-upstream catch in
   * `init` so one upstream's failure degrades only that upstream.
   */
  private async prepareUpstream(
    row: UpstreamServerRow,
    cached: UpstreamToolRow[]
  ): Promise<{ conn: UpstreamConnection; client: UpstreamClient; tools: UpstreamToolRow[] } | null> {
    const conn = safeConnection(row)
    if (!conn) return null
    const bearer = await this.resolveBearer(row, conn)
    if (conn.authStrategy !== 'none' && bearer === null) return null

    const client = this.makeClient(conn, bearer)
    const tools = await this.ensureCatalogue(conn, client, cached)
    if (tools.length === 0) {
      // Empty even after refresh — log and skip; user sees built-ins only.
      console.warn(`upstream ${conn.slug} returned no tools after refresh`)
      await client.close()
      return null
    }
    return { conn, client, tools }
  }

  private async ensureCatalogue(
    conn: UpstreamConnection,
    client: UpstreamClient,
    cached: UpstreamToolRow[]
  ): Promise<UpstreamToolRow[]> {
    // Staleness is derived from the prefetched rows (cached_at rides on
    // every row), so the fresh path costs no extra round trip.
    const cachedAt = cached.length === 0 ? null : Math.max(...cached.map((t) => t.cached_at))
    const stale = cachedAt === null || Date.now() / 1000 - cachedAt > CATALOGUE_TTL_SECONDS
    if (!stale) return cached
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
    row: UpstreamToolRow,
    pointers: string[] = []
  ): void {
    const mangled = mangleToolName(conn.slug, row.tool_name)
    // Upstream-supplied descriptions are untrusted model input. Strip
    // control characters (which can hide injected instructions or
    // disrupt agent rendering) before forwarding. We deliberately do
    // NOT try to detect prompt-injection content — that's the model's
    // job; ours is to keep the wire bytes well-formed.
    let description = truncateDescription(
      sanitizeUntrustedText(`[${conn.displayName}] ${row.description ?? ''}`)
    )
    // Append org-curated per-tool attachment pointers. These are
    // first-party (slug strings we control), not upstream input, so they
    // need no sanitisation. Truncate the base description first to
    // reserve room — the pointer is the binding guidance and must
    // survive the 1024-char cap even when the upstream blurb is long.
    if (pointers.length > 0) {
      const suffix = `\n\n[ctxlayer] Org convention applies — consult ${pointers.join(
        ', '
      )} before using this tool.`
      description = truncateDescription(description, 1024 - suffix.length) + suffix
    }
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
    const handler = async (args: unknown, extra?: ProxyToolExtra) => {
      if (!unmangleToolName(mangled)) return errText(`bad tool name: ${mangled}`)
      // Defense-in-depth: only ACL-allowed tools are ever registered, so
      // this can't fire on the normal path. It backstops a future
      // refactor that registers more broadly. Generic code to the agent;
      // the real reason is logged server-side per the no-leak rule.
      if (!this.allowedToolKeys.has(accessKey(conn.id, upstreamToolName))) {
        console.warn(`[tool-acl] blocked ${conn.slug}.${upstreamToolName} for user ${this.userId}`)
        return errText('access_denied: tool restricted')
      }
      const client = this.clients.get(conn.id)
      if (!client) return errText(`upstream ${conn.slug} not connected`)
      const t0 = Date.now()
      const reqJson = safeJson(args)
      let status: 'ok' | 'error' | 'timeout' = 'ok'
      let truncated = false
      let respJson = ''
      try {
        const result = await callWithHeartbeat(extra, () =>
          client.callTool(upstreamToolName, args)
        )
        respJson = safeJson(result.content ?? null)
        if (result.isError) status = 'error'
        // Response-size guardrail (WI-4). An oversized upstream payload
        // (e.g. Driver's whole-repo get_code_map ≈ 1.4 MB) would nuke the
        // agent's context and waste the usage tokeniser. Replace it with a
        // structured truncation notice. Applied on the assembled result —
        // the SDK materialises `content` in memory today; if true streaming
        // passthrough lands, move this to a byte-counter in the stream.
        const respBytes = byteLength(respJson)
        const cap = conn.authConfig.maxResponseBytes ?? UPSTREAM_MAX_RESPONSE_BYTES
        if (!result.isError && respBytes > cap) {
          truncated = true
          const notice = truncationNotice(conn.slug, upstreamToolName, respBytes, cap)
          // Record the short notice (not the megabyte blob) for usage.
          respJson = notice
          return { isError: false, content: [{ type: 'text' as const, text: notice }] }
        }
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
        await this.stageUsage({
          userId: this.userId,
          sessionId: this.sessionId,
          upstreamId: conn.id,
          tool: mangled,
          reqJson,
          respJson,
          latencyMs: Date.now() - t0,
          status,
          truncated
        })
      }
    }
    // The SDK's `registerTool` overload requires a Zod schema at the
    // type level but happily accepts our derived shape at runtime.
    // Single cast on the call keeps the handler closed-over types
    // intact (alternative: cast the inputSchema to `never`, which
    // collapses the callback signature to `() => ...`).
    ;(
      server.registerTool as unknown as (
        name: string,
        cfg: { title: string; description: string; inputSchema: unknown },
        cb: (args: unknown, extra: ProxyToolExtra) => unknown
      ) => unknown
    )(
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

/**
 * The caller's group memberships (teams, products, roles), resolved in
 * one pass for the per-tool ACL. Products are transitive via teams
 * (resolveUserScope); roles are direct. `init()` uses this; the
 * `list_my_context` handler builds the same shape from data it already
 * fetched and feeds it to `restrictedToolsFor()` so both evaluate the
 * exact same principal set.
 */
async function resolveUserPrincipals(env: Env, userId: string): Promise<UserPrincipals> {
  const [scope, roleIds] = await Promise.all([
    resolveUserScope(env, userId),
    listUserRoleIds(env, userId)
  ])
  return {
    teams: new Set(scope.teams),
    products: new Set(scope.products),
    roles: new Set(roleIds)
  }
}

export function truncateDescription(s: string, max = 1024): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

/**
 * Whole-upstream attachment pointers (tool_name = '') as ready-to-render
 * ref strings, in skills-then-docs order. These name the org playbook for
 * the WHOLE upstream and feed two surfaces: the server `instructions` tail
 * (`upstreamGuidance`) and — fanned out onto every one of that upstream's
 * tools in `init` — the per-tool description suffix. Per-tool rows
 * (tool_name != '') are skipped here; `perToolPointers` owns those.
 */
export function wholeUpstreamPointers(
  skills: SkillForUpstreamRow[],
  docs: DocForUpstreamRow[]
): string[] {
  return [
    ...skills.filter((s) => s.tool_name === '').map((s) => `skill \`${s.slug}\` (get_skill)`),
    ...docs.filter((d) => d.tool_name === '').map((d) => `doc \`${d.slug}\` (get_doc)`)
  ]
}

/**
 * Group per-tool attachment pointers (tool_name != '') by upstream tool
 * name. Whole-upstream rows (tool_name = '') are skipped here — they are
 * fanned out onto every tool of the upstream in `init` via
 * `wholeUpstreamPointers`, and also named in the server `instructions`.
 * Skills and docs are merged into one ordered list per tool so a tool can
 * carry both.
 */
export function perToolPointers(
  skills: SkillForUpstreamRow[],
  docs: DocForUpstreamRow[]
): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const add = (toolName: string, ref: string) => {
    if (toolName === '') return
    const arr = out.get(toolName) ?? []
    arr.push(ref)
    out.set(toolName, arr)
  }
  for (const s of skills) add(s.tool_name, `skill \`${s.slug}\` (get_skill)`)
  for (const d of docs) add(d.tool_name, `doc \`${d.slug}\` (get_doc)`)
  return out
}

/**
 * Strip C0 control characters (except tab/newline/carriage return) and
 * the C1 range from an untrusted string before we hand it to the model
 * or echo it back over the wire. Keeps regular punctuation, whitespace,
 * and Unicode intact.
 */
function sanitizeUntrustedText(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: deliberately matches control chars to strip them
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '')
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

export function isTimeoutError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  // Both the upstream/http-client 60s wall cap and the MCP SDK's
  // own RequestTimeoutError surface as messages mentioning timeout.
  return /timeout|timed out|deadline/i.test(msg)
}

/** Emit a heartbeat progress ping roughly this often during a long call. */
const HEARTBEAT_MS = 25_000

/**
 * The slice of the SDK's `RequestHandlerExtra` the proxy handler needs:
 * the caller's `progressToken` (present only if the client requested
 * progress) and a `sendNotification` bound to this request's stream.
 * Typed minimally so the `registerTool` cast stays self-contained.
 */
type ProxyToolExtra = {
  _meta?: { progressToken?: string | number }
  sendNotification?: (n: {
    method: 'notifications/progress'
    params: { progressToken: string | number; progress: number; message?: string }
  }) => Promise<void>
}

/**
 * Run a (potentially multi-minute) upstream call while keeping the stream
 * back to the agent alive. A silent call lets intermediaries drop the
 * connection — notably Anthropic's hosted MCP proxy (`-32000 "MCP server
 * connection lost"`) and Claude Code's 5-min idle timer — so we send a
 * `notifications/progress` ping every HEARTBEAT_MS for the duration.
 *
 * No-op unless the client supplied a `progressToken` (i.e. requested
 * progress): the spec ties progress notifications to that token, so
 * without one there is nothing valid to send. Best-effort — a failed
 * ping (e.g. the stream is already closing) is swallowed.
 */
export async function callWithHeartbeat<T>(
  extra: ProxyToolExtra | undefined,
  run: () => Promise<T>
): Promise<T> {
  const token = extra?._meta?.progressToken
  const send = extra?.sendNotification
  if (token == null || !send) return run()
  let progress = 0
  const timer = setInterval(() => {
    progress += 1
    void send({
      method: 'notifications/progress',
      params: { progressToken: token, progress, message: 'Upstream call in progress…' }
    }).catch(() => {})
  }, HEARTBEAT_MS)
  try {
    return await run()
  } finally {
    clearInterval(timer)
  }
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

/**
 * Structured notice substituted for an upstream response that exceeded
 * the relay size cap (WI-4). Generic scope hint — we don't know each
 * tool's pagination params, so we name the common levers. First-party
 * text (no upstream input), so no sanitisation needed.
 */
export function truncationNotice(slug: string, tool: string, bytes: number, cap: number): string {
  return (
    `[ctxlayer] The response from ${slug}.${tool} was ${bytes} bytes, over the ` +
    `${cap}-byte relay cap, and was withheld to protect the agent's context. ` +
    `Re-run with a narrower scope (e.g. a path, directory, depth, or page/limit ` +
    `argument) so the tool returns a smaller payload.`
  )
}
