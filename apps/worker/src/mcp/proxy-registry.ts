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
 *   - Tool handlers dispatch through the cached `UpstreamClient` via
 *     `upstream-call-runner.ts`, or through `async-submit.ts` for
 *     tools on the upstream's `authConfig.asyncTools`.
 *   - There is no teardown: sessions are short-lived and the workerd
 *     isolate frees Client state on its own when the DO dies.
 *
 * Catalogue freshness: a row older than `CATALOGUE_TTL_SECONDS` is
 * refreshed inline on first session encounter — accepted as a one-time
 * connect cost so the agent sees a complete `tools/list` immediately.
 * Empty cache (brand-new upstream) is also refreshed inline.
 *
 * The read-models behind `describe_upstream` / `list_upstreams` /
 * `restrictedTools` live in `catalogue-views.ts`.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Env } from '../env'
import {
  toUpstreamConnection,
  type UpstreamConnection,
  type UpstreamServerRow
} from '../db/queries/upstreams'
import { listCachedTools, listCachedToolsForUpstreams, replaceCachedTools, type UpstreamToolRow } from '../db/queries/upstream-tools'
import type { SkillForUpstreamRow } from '../db/queries/skill-attachments'
import type { DocForUpstreamRow } from '../db/queries/doc-attachments'
import {
  accessKey,
  indexToolAccess,
  listToolAccessForUpstreams,
  resolveUserPrincipals
} from '../db/queries/tool-access'
import { createUpstreamClient } from '../upstream/create-client'
import type { UpstreamClient } from '../upstream/upstream-client'
import { isToolAllowed } from '@ctxlayer/shared'
import { resolveUserUpstreamBearer } from '../upstream/bearer'
import { mangleToolName, unmangleToolName } from './tool-name'
import { firstParty, sanitizeUntrustedText } from './provenance'
import { jsonSchemaToZod } from './json-schema-to-zod'
import { classifyUpstreamError, scrubErrorForStorage } from '../usage/error-detail'
import type { RecordUsageArgs } from '../usage/record'
import { errMessage } from '../util/errors'
import { errText, safeJson } from './tool-result'
import {
  loadUserContext,
  perToolPointers,
  truncateDescription,
  type UpstreamUserContext
} from './catalogue-views'
import {
  callWithHeartbeat,
  runUpstreamCall,
  type ProxyToolExtra
} from './upstream-call-runner'
import { isAsyncTool, submitAsyncJob } from './async-submit'
import { credentialFreshnessError } from './credential-freshness'

// 24h cache TTL per docs/plan/C-upstream-proxy.md §C1.
const CATALOGUE_TTL_SECONDS = 24 * 60 * 60

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
   * Hydrate the registry and register one MCP tool per cached upstream
   * tool. Safe to call before any built-in tools are registered — the
   * SDK accumulates handlers across calls and the eventual `tools/list`
   * returns the union. Accepts the prefetched per-user context from
   * `loadUserContext` (session init shares it with `upstreamGuidance`);
   * loads it itself when not supplied.
   */
  async init(server: McpServer, ctx?: UpstreamUserContext): Promise<void> {
    const { rows, skillsByUpstream, docsByUpstream } =
      ctx ?? (await loadUserContext(this.env, this.userId))
    await this.registerUpstreams(server, rows, skillsByUpstream, docsByUpstream)
  }

  /**
   * Re-scan the caller's upstreams and grow this session's registered
   * tool set to match reality:
   *   1. Register every tool of any upstream connected AFTER this
   *      session's `init` (a mid-session connect is otherwise invisible
   *      until the MCP client reconnects).
   *   2. Reconcile ALREADY-connected upstreams against the org-global
   *      catalogue — the cache may have been refreshed (or healed from a
   *      degraded `tools/list`) by another session/admin since this
   *      session registered, leaving this session bound to a subset
   *      (2026-08-11 Datadog incident: sessions stuck on 3 of 25 tools).
   *      Newly-visible allowed tools are registered; nothing is ever
   *      unregistered mid-session (ACL revocation is backstopped in the
   *      call handler instead).
   * Idempotent: already-registered tools are skipped, so no tool is
   * double-registered (registering a duplicate name would throw). Emits
   * `tools/list_changed` on the live server when something new registers —
   * a client that honors it surfaces the tools without a reconnect.
   * Returns a summary of what was added on either path.
   */
  async refresh(
    server: McpServer
  ): Promise<{ added: { slug: string; tools: number }[]; loaded: number }> {
    const { rows, skillsByUpstream, docsByUpstream } = await loadUserContext(this.env, this.userId)
    const fresh = rows.filter((r) => !this.clients.has(r.id))
    const added = (
      await this.registerUpstreams(server, fresh, skillsByUpstream, docsByUpstream)
    ).filter((a) => a.tools > 0)
    added.push(
      ...(await this.reconcileConnected(
        server,
        rows.filter((r) => this.clients.has(r.id)),
        skillsByUpstream,
        docsByUpstream
      ))
    )
    if (added.length > 0) {
      // The live session's tool set grew — tell the client to re-read.
      // Belt-and-suspenders: the SDK also emits on `registerTool` when the
      // server is connected, but an explicit send is harmless (an
      // idempotent re-fetch) and covers SDK versions that don't auto-notify.
      try {
        server.server.sendToolListChanged()
      } catch (err) {
        console.error('[upstream-proxy] sendToolListChanged failed:', err)
      }
    }
    return { added, loaded: this.clients.size }
  }

  /**
   * Register tools that appeared in the catalogue after this session
   * bound an upstream (see `refresh` step 2). Re-runs the same
   * freshness check `init` used — `ensureCatalogue` dials only when the
   * cache is empty/stale, reusing this session's live client — then
   * registers every allowed tool not yet in `allowedToolKeys` (the
   * registered set). Per-upstream failures degrade only that upstream.
   */
  private async reconcileConnected(
    server: McpServer,
    rows: UpstreamServerRow[],
    skillsByUpstream: Map<string, SkillForUpstreamRow[]>,
    docsByUpstream: Map<string, DocForUpstreamRow[]>
  ): Promise<{ slug: string; tools: number }[]> {
    if (rows.length === 0) return []
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
    const out: { slug: string; tools: number }[] = []
    for (const row of rows) {
      try {
        const conn = safeConnection(row)
        if (!conn) continue
        const client = this.clients.get(conn.id)
        if (!client) continue
        const tools = await this.ensureCatalogue(conn, client, cachedByUpstream.get(conn.id) ?? [])
        const perTool = perToolPointers(
          skillsByUpstream.get(conn.id) ?? [],
          docsByUpstream.get(conn.id) ?? []
        )
        let count = 0
        for (const t of tools) {
          const key = accessKey(conn.id, t.tool_name)
          if (this.allowedToolKeys.has(key)) continue // registered this session
          if (!isToolAllowed(acl.get(key), principals)) continue // hidden by ACL
          this.allowedToolKeys.add(key)
          this.registerTool(server, conn, t, perTool.get(t.tool_name) ?? [])
          count++
        }
        if (count > 0) out.push({ slug: conn.slug, tools: count })
      } catch (err) {
        console.error(`[upstream-proxy] ${row.slug}: reconcile failed: ${errMessage(err)}`)
      }
    }
    return out
  }

  /**
   * Prepare + register one MCP tool per allowed cached tool for the given
   * upstream rows. Shared by `init` (all visible upstreams) and `refresh`
   * (only the newly-connected ones). Returns per-upstream registered-tool
   * counts in `rows` order — registration is sequential so `tools/list`
   * stays deterministic.
   */
  private async registerUpstreams(
    server: McpServer,
    rows: UpstreamServerRow[],
    skillsByUpstream: Map<string, SkillForUpstreamRow[]>,
    docsByUpstream: Map<string, DocForUpstreamRow[]>
  ): Promise<{ slug: string; tools: number }[]> {
    if (rows.length === 0) return []
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
          const msg = errMessage(err)
          console.error(`[upstream-proxy] ${row.slug}: init failed: ${msg}`)
          return null
        })
      )
    )
    const added: { slug: string; tools: number }[] = []
    for (const prep of prepped) {
      if (!prep) continue
      const { conn, client, tools } = prep
      this.clients.set(conn.id, client)
      const skills = skillsByUpstream.get(conn.id) ?? []
      const docs = docsByUpstream.get(conn.id) ?? []
      // Only PER-TOOL pointers (tool_name != '') ride the description now.
      // Whole-upstream playbooks (tool_name = '') are NOT fanned onto every
      // tool anymore — they already live in the server `instructions`
      // (`upstreamGuidance`) and in `list_upstreams.attached_skills`, so
      // repeating them on each tool was redundant noise. Per-tool bindings also
      // have a structured home in `describe_upstream`; this description line is
      // just passive discoverability for the tool-specific ones.
      const perTool = perToolPointers(skills, docs)
      let count = 0
      for (const t of tools) {
        const key = accessKey(conn.id, t.tool_name)
        if (!isToolAllowed(acl.get(key), principals)) continue // hidden by ACL
        this.allowedToolKeys.add(key)
        this.registerTool(server, conn, t, perTool.get(t.tool_name) ?? [])
        count++
      }
      added.push({ slug: conn.slug, tools: count })
    }
    return added
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
      const res = await replaceCachedTools(this.env, conn.id, tools)
      if (res.rejectedShrink) {
        console.warn(
          `[catalogue] ${conn.slug}: refresh returned ${res.rejectedShrink.incoming} tools vs ` +
            `${res.rejectedShrink.prior} cached — suspect shrink rejected, serving prior catalogue`
        )
      }
    } catch (err) {
      const msg = errMessage(err)
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
      // Descriptive disclosure, NOT an imperative: name the org playbooks that
      // exist for this tool and leave the choice to the agent. The old
      // "consult X before using this tool" framing was a command smuggled
      // through the data plane — well-behaved agents (correctly) treat tool
      // metadata as untrusted and resist it, so it was both brittle and
      // eroding of the very boundary that protects callers from a malicious
      // upstream's descriptions. The structured home for these is
      // `describe_upstream` (per-tool `attached_skills`/`attached_docs`); this
      // line is just passive discoverability on the one field every client
      // renders. Wrapped in the ⟦ctxlayer⟧ provenance marker (first-party,
      // unforgeable — the upstream description above it is defanged).
      const suffix = `\n\n${firstParty(`Related org playbooks (optional context): ${pointers.join(', ')}.`)}`
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
      // A6: user-scoped creds were bound at session init — one point-read
      // per call so a mid-session disconnect / reauth flag blocks now, not
      // when the session dies. Also gates async SUBMITs (below).
      const staleCred = await credentialFreshnessError(this.env, this.userId, conn)
      if (staleCred) {
        console.warn(
          `[cred-freshness] blocked ${conn.slug}.${upstreamToolName} for user ${this.userId}`
        )
        return errText(staleCred)
      }
      const t0 = Date.now()
      const reqJson = safeJson(args)
      let status: 'ok' | 'error' | 'timeout' = 'ok'
      let truncated = false
      let respJson = ''
      // Set only on failures — a coarse class + the raw detail (scrubbed
      // for storage in the `finally`). Drives the usage error table.
      let errorCode: string | undefined
      let errorDetail: string | undefined
      try {
        // Async-eligible tools (per `authConfig.asyncTools`) can run far
        // longer than an interactive client's request timeout — Claude
        // Desktop hard-caps at ~180s and does not reset on progress, so no
        // server-side keepalive helps. Run them out-of-band: enqueue a job,
        // return a token immediately, and let the ctxlayer-jobs consumer run
        // the full call (poll_task fetches the result). A retried identical
        // call returns the cached result. See docs/plan/I-upstream-resilience §I9.
        if (isAsyncTool(conn, upstreamToolName)) {
          try {
            const sub = await submitAsyncJob(
              this.env,
              { userId: this.userId, sessionId: this.sessionId },
              conn,
              upstreamToolName,
              args
            )
            respJson = sub.respJson
            return sub.surface
          } catch (err) {
            // A failed submit (D1 insert, queue send) reaches the agent as a
            // thrown error — record it as one, not as a zero-byte 'ok'.
            status = 'error'
            errorDetail = errMessage(err)
            errorCode = classifyUpstreamError('error', errorDetail)
            throw err
          }
        }
        const outcome = await runUpstreamCall({
          slug: conn.slug,
          toolName: upstreamToolName,
          upstreamUrl: conn.url,
          maxResponseBytes: conn.authConfig.maxResponseBytes,
          run: () => callWithHeartbeat(extra, () => client.callTool(upstreamToolName, args))
        })
        respJson = outcome.respJson
        status = outcome.status
        truncated = outcome.truncated
        errorCode = outcome.errorCode
        errorDetail = outcome.errorDetail
        return outcome.surface
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
          truncated,
          errorCode,
          errorMessage: errorDetail != null ? scrubErrorForStorage(errorDetail) : undefined
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
