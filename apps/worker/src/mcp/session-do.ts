/**
 * Per-session MCP server, extending `McpAgent` from the agents SDK.
 *
 * Built-in tools (M2c B2):
 *   - whoami              — diagnostic; returns the session's user props
 *   - list_my_context     — teams + products + accessibleUpstreams + default scope
 *   - list_upstreams      — empty until M4 ships the proxy layer
 *   - get_doc(id)         — read R2 snapshot → markdown
 *   - search_docs(query, k?, scope?) — embed query → Vectorize → scope-filter
 *
 * Per-request props (set by `provider.completeAuthorization` in the
 * IdP callback) arrive on `this.props` — see `Env.McpProps`.
 */

import { McpAgent } from 'agents/mcp'
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { Env, McpProps } from '../env'
import { findById } from '../db/queries/users'
import { getDocByIdOrSlug, listDocs } from '../db/queries/docs'
import { resolveUserScope } from '../db/queries/doc-tags'
import { readSnapshot } from '../storage/docs-r2'
import { renderBlocksToMarkdown } from '../rag/markdown'
import {
  searchDocs,
  effectiveScope,
  availableScopeFor,
  SEARCH_K_DEFAULT,
  SEARCH_K_MAX
} from '../rag/search'
import { UpstreamProxyRegistry, type UpstreamUserContext } from './tools-proxy'
import { listUpstreamsVisibleToUser } from '../db/queries/upstreams'
import { listUserRoleIds } from '../db/queries/roles'
import { registerSkillMcp } from './skill-mcp'
import { buildUsageMsg, type RecordUsageArgs } from '../usage/record'
import { errorTextFromContent, scrubErrorForStorage } from '../usage/error-detail'
import { ensureOutboxTable, stageUsageRow, drainOutbox } from '../usage/outbox'
import {
  SearchScope,
  McpMyContext,
  McpSearchResult,
  McpListUpstreamsResult
} from '@ctxlayer/shared'

// Usage-outbox drain cadence. Staged usage rows are flushed to
// USAGE_QUEUE by `flushUsageOutbox` on a short, coalesced delay so a
// burst of tool calls in a session shares one drain (the schedule is
// idempotent on callback). Rescheduled on a longer horizon after a
// queue-send failure so a down queue can't spin the DO awake.
const USAGE_DRAIN_DELAY_SECONDS = 5
const USAGE_DRAIN_RETRY_SECONDS = 30

/**
 * Server-level usage hint surfaced to the agent via MCP's
 * `initialize.instructions`. Most MCP clients (Claude.ai, Claude
 * Code, Cursor) thread this into the model's context so it knows
 * how to reason about ctxlayer's surface alongside any proxied
 * upstream's tools. Keep it terse — it ships on every connect.
 */
const SERVER_INSTRUCTIONS = `ctxlayer is your org's curated context layer. Alongside the proxied upstream tools (mangled as \`<upstream-slug>__<tool>\`), it exposes:

- \`list_my_context\` — your team / product scopes + the upstreams visible to you.
- \`list_upstreams\` — visible upstreams with their cached tool counts AND any \`attached_skills\` / \`attached_docs\` (procedural playbooks + reference docs the org has curated for that upstream).
- \`list_skills\` — every published skill, each carrying \`attached_to: [{ upstream_slug, tool_name }]\`.
- \`get_skill\` / resource \`mcp://ctxlayer/skills/{slug}\` — the skill body (markdown playbook).
- \`get_doc\` / \`search_docs\` / resource \`mcp://ctxlayer/docs/{id}\` — the doc library with semantic search.

**When the user's request touches an upstream tool, follow this discovery order before calling:**

1. Call \`list_upstreams\` once per session to see the inventory. Note the \`attached_skills\` on the relevant upstream — those are your org's "how we do X with this service" playbooks.
2. If an attached skill looks relevant, read it via \`get_skill\` BEFORE calling the upstream tool. Skills typically encode team IDs, label conventions, status-name choices, and prefer-this-tool-over-that-one guidance the schema alone doesn't show.
3. Per-tool attachments (visible in skill.attached_to with a non-null \`tool_name\`) are narrower; consult those when about to call that specific tool.

Skills are reference material, not auto-loaded — you decide when to fetch one. Reading an attached skill is cheap (one short markdown body) and often saves a round of upstream calls.`

export class McpSessionDO extends McpAgent<Env, undefined, McpProps> {
  server = new McpServer(
    { name: 'ctxlayer', version: '0.1.0' },
    { instructions: SERVER_INSTRUCTIONS }
  )

  private upstreamProxy: UpstreamProxyRegistry | null = null

  async init(): Promise<void> {
    const userId = this.props?.userId

    // Lifecycle gate (plan L). A suspended or hard-deleted account gets an
    // empty MCP surface on its next connect, even if its OAuth token is still
    // technically valid. This blocks NEW sessions; an already-open session is
    // cut when the admin revokes the user's credentials/grant.
    if (userId) {
      const account = await findById(this.env, userId)
      if (!account || account.status !== 'active') {
        this.server = new McpServer(
          { name: 'ctxlayer', version: '0.1.0' },
          { instructions: 'Your ctxlayer access is not active. Contact your workspace admin.' }
        )
        return
      }
    }

    // Usage outbox lives in this DO's own SQLite (see usage/outbox.ts).
    // Tool calls stage rows here synchronously; `flushUsageOutbox`
    // drains them to the queue on an alarm, so a cancelled `waitUntil`
    // can no longer drop a usage event (the old /mcp failure mode).
    ensureOutboxTable(this.ctx.storage.sql)

    // Per-session server `instructions`: the static base + any
    // *whole-upstream* skill/doc attachments named explicitly. Those
    // attachments (e.g. the "linear-practices" doc) encode org
    // conventions the upstream tool schemas don't show; naming them
    // here means the agent sees the obligation on connect instead of
    // having to discover it via `list_upstreams` + a follow-up fetch.
    // Per-tool attachments ride on the individual tool's description
    // instead (see `UpstreamProxyRegistry.registerTool`). Built before
    // any tool registers because the SDK reads `instructions` when it
    // answers `initialize`, which happens after `init()` returns — and
    // the `McpAgent` constructor never touches `this.server`, so the
    // eagerly-built instance is safe to replace here.
    // The visible-upstreams rows + attachments are loaded ONCE here and
    // shared with the proxy registry's `init()` below, so a connect costs
    // one visibility query + two attachment batches instead of re-running
    // them per consumer (and per upstream).
    let upstreamCtx: UpstreamUserContext | null = null
    if (userId) {
      try {
        upstreamCtx = await UpstreamProxyRegistry.loadUserContext(this.env, userId)
        const guidance = UpstreamProxyRegistry.upstreamGuidance(upstreamCtx)
        if (guidance) {
          this.server = new McpServer(
            { name: 'ctxlayer', version: '0.1.0' },
            { instructions: SERVER_INSTRUCTIONS + guidance }
          )
        }
      } catch (err) {
        console.error('server-instructions guidance build failed:', err)
      }
    }

    // Usage-recording wrapper for built-in tools (upstreamId = null).
    // Returns the inner result untouched; records bytes/tokens/latency
    // + 'ok' / 'error' status (from `isError` flag) on every call.
    // Errors thrown by `exec` propagate after recording.
    const rec = <T extends { content?: unknown; isError?: boolean }>(
      tool: string,
      args: unknown,
      exec: () => Promise<T>
    ): Promise<T> => {
      const t0 = Date.now()
      const reqJson = safeJson(args)
      const userId = this.props?.userId ?? ''
      const sessionId = this.getSessionId()
      // Built-ins have no upstream, so a failure is always `local_error`;
      // `errorSrc` is the raw detail (scrubbed here for the usage table).
      const finalize = (respJson: string, status: 'ok' | 'error', errorSrc?: string) =>
        this.stageUsage({
          userId,
          sessionId,
          upstreamId: null,
          tool,
          reqJson,
          respJson,
          latencyMs: Date.now() - t0,
          status,
          ...(status === 'error'
            ? {
                errorCode: 'local_error',
                errorMessage: scrubErrorForStorage(errorSrc ?? respJson)
              }
            : {})
        })
      return exec().then(
        async (result) => {
          await finalize(
            safeJson(result.content),
            result.isError ? 'error' : 'ok',
            result.isError ? errorTextFromContent(result.content) : undefined
          )
          return result
        },
        async (err) => {
          const m = stringifyError(err)
          await finalize(m, 'error', m)
          throw err
        }
      )
    }

    this.server.registerTool(
      'whoami',
      {
        title: 'Who am I?',
        description: 'Returns the user props attached to this MCP session by ctxlayer.'
      },
      () =>
        rec('whoami', undefined, async () => ({
          content: [{ type: 'text', text: JSON.stringify(this.props ?? null, null, 2) }]
        }))
    )

    this.server.registerTool(
      'list_my_context',
      {
        title: 'List my context',
        description:
          'Returns the teams + products the caller belongs to (transitively via team membership), the accessible upstream MCP servers, and the reachable team/product scope (used to NARROW search; `search_docs` itself defaults to open-read across all docs).',
        outputSchema: McpMyContext.shape
      },
      () =>
        rec('list_my_context', undefined, async () => {
          const userId = this.props?.userId
          if (!userId) return errText('not_signed_in')
          // Scope, roles, and the visible-upstream rows are fetched once
          // and feed BOTH the context body and the restricted-tools
          // advisory (which used to re-run all three internally).
          const [scope, roleIds, rows] = await Promise.all([
            resolveUserScope(this.env, userId),
            listUserRoleIds(this.env, userId),
            listUpstreamsVisibleToUser(this.env, userId)
          ])
          const accessibleUpstreams = rows.map((r) => r.slug)
          const restrictedTools = await UpstreamProxyRegistry.restrictedToolsFor(this.env, rows, {
            teams: new Set(scope.teams),
            products: new Set(scope.products),
            roles: new Set(roleIds)
          })
          // Typed against the shared MCP contract so the serialised shape
          // can't drift from `McpMyContext`.
          const body: McpMyContext = {
            teams: scope.teams,
            products: scope.products,
            accessibleUpstreams,
            restrictedTools,
            defaultScope: scope
          }
          return {
            content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
            structuredContent: body
          }
        })
    )

    this.server.registerTool(
      'list_upstreams',
      {
        title: 'List upstreams',
        description:
          'Lists the upstream MCP servers visible to the caller, with connected state, transport, and cached tool count. Disconnected upstreams point the user at /upstreams to paste a token.',
        // structuredContent must be an object, so the entry array is wrapped
        // under `upstreams`. The text `content` keeps the bare array for
        // back-compat with clients that read the rendered JSON.
        outputSchema: { upstreams: McpListUpstreamsResult }
      },
      () =>
        rec('list_upstreams', undefined, async () => {
          const userId = this.props?.userId
          if (!userId) return errText('not_signed_in')
          const entries = await UpstreamProxyRegistry.listUpstreamsForUser(this.env, userId)
          return {
            content: [{ type: 'text', text: JSON.stringify(entries, null, 2) }],
            structuredContent: { upstreams: entries }
          }
        })
    )

    this.server.registerTool(
      'get_doc',
      {
        title: 'Get document',
        description: 'Returns the markdown for a doc by id or slug.',
        inputSchema: { id: z.string().min(1) }
      },
      (args) =>
        rec('get_doc', args, async () => {
          const { id } = args
          const doc = await getDocByIdOrSlug(this.env, id)
          if (!doc) return errText(`doc not found: ${id}`)
          const content = await readSnapshot(this.env, doc.id)
          const markdown = content ? renderBlocksToMarkdown(content.blocks) : ''
          return {
            content: [
              {
                type: 'text',
                text: `# ${doc.title}\n\n${markdown || '_empty document_'}`
              }
            ]
          }
        })
    )

    this.server.registerTool(
      'search_docs',
      {
        title: 'Search docs',
        description:
          'Semantic search over the org-curated doc library. Open-read: searches ALL docs by default (docs are readable org-wide; tags narrow, they do not hide). Pass `scope: { teams: [...], products: [...] }` to narrow to docs carrying those team/product tags (intersected with the caller\'s reachable set, no escalation). `scope: "all"` is the explicit form of the default.',
        inputSchema: {
          query: z.string().min(1),
          k: z.number().int().min(1).max(SEARCH_K_MAX).optional(),
          // Same `SearchScope` the REST /api/search contract uses.
          scope: SearchScope.optional()
        },
        outputSchema: McpSearchResult.shape
      },
      (args) =>
        rec('search_docs', args, async () => {
          const { query, k, scope } = args
          const userId = this.props?.userId
          if (!userId) return errText('not_signed_in')

          // Shared retrieval core (also backs REST /api/search): query
          // understanding → multi-query dense recall → cross-encoder rerank.
          const userScope = await resolveUserScope(this.env, userId)
          const effective = effectiveScope(scope, userScope)
          const available = await availableScopeFor(this.env, userScope)
          const { hits: matches } = await searchDocs(this.env, {
            query,
            k: k ?? SEARCH_K_DEFAULT,
            effective,
            available
          })

          // Typed against the shared MCP contract (see `McpSearchResult`).
          const body: McpSearchResult = { matches }
          return {
            content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
            structuredContent: body
          }
        })
    )

    // ----- skill MCP surface (M7a) -----
    // list_skills + get_skill tools + mcp://ctxlayer/skills/{slug}
    // resource template. Extracted to mcp/skill-mcp.ts to keep this
    // file focused on session lifecycle.
    registerSkillMcp(this.server, this.env, rec)

    // ----- doc resources: mcp://ctxlayer/docs/{id} -----
    // The MCP `ResourceTemplate` lets the SDK expand `{id}` into the
    // calling URI, and our `list` callback exposes the available
    // resources so MCP clients can discover docs without guessing
    // IDs. Per-doc reads stream the snapshot rendered as markdown.
    const template = new ResourceTemplate('mcp://ctxlayer/docs/{id}', {
      list: async () => {
        const docs = await listDocs(this.env)
        return {
          resources: docs.map((d) => ({
            uri: `mcp://ctxlayer/docs/${d.id}`,
            name: d.title,
            description: d.doc_type ? `${d.slug} · ${d.doc_type}` : d.slug,
            mimeType: 'text/markdown'
          }))
        }
      }
    })

    // Hydrate proxied upstream tools alongside the built-ins. Best-effort:
    // a failure here must not block built-ins (search_docs / get_doc) from
    // serving. Each upstream's own listTools/callTool errors are caught
    // inside the registry; we only need to guard the enumeration itself.
    if (userId) {
      try {
        this.upstreamProxy = new UpstreamProxyRegistry(
          this.env,
          userId,
          (args) => this.stageUsage(args),
          this.getSessionId()
        )
        await this.upstreamProxy.init(this.server, upstreamCtx ?? undefined)
      } catch (err) {
        console.error('upstream proxy init failed:', err)
        this.upstreamProxy = null
      }
    }

    this.server.registerResource(
      'doc',
      template,
      {
        title: 'Curated documents',
        description: 'All non-deleted docs in the ctxlayer library.'
      },
      async (uri: URL, variables: { id?: string | string[] }) => {
        const idVar = variables.id
        const id = Array.isArray(idVar) ? idVar[0] : idVar
        if (!id) {
          return { contents: [{ uri: uri.toString(), text: 'missing doc id' }] }
        }
        const doc = await getDocByIdOrSlug(this.env, id)
        if (!doc) {
          return { contents: [{ uri: uri.toString(), text: `doc not found: ${id}` }] }
        }
        const content = await readSnapshot(this.env, doc.id)
        const markdown = content ? renderBlocksToMarkdown(content.blocks) : ''
        return {
          contents: [
            {
              uri: uri.toString(),
              mimeType: 'text/markdown',
              text: `# ${doc.title}\n\n${markdown}`
            }
          ]
        }
      }
    )
  }

  /**
   * Stage a usage event in the DO's SQLite outbox and ensure a drain is
   * scheduled. The insert is synchronous (durable immediately); the
   * idempotent `flushUsageOutbox` schedule coalesces a burst of tool
   * calls into one drain. Replaces the old fire-and-forget
   * `ctx.waitUntil(queue.send)`, whose background send was cancelled
   * once a streaming /mcp response ended. Never throws into the tool
   * path — a lost usage row must never break a working tool call.
   */
  private async stageUsage(args: RecordUsageArgs): Promise<void> {
    try {
      stageUsageRow(this.ctx.storage.sql, buildUsageMsg(args))
      await this.schedule(USAGE_DRAIN_DELAY_SECONDS, 'flushUsageOutbox', undefined, {
        idempotent: true
      })
    } catch (err) {
      console.error(`[usage] stage failed for ${args.tool}: ${stringifyError(err)}`)
    }
  }

  /**
   * Alarm callback (dispatched by the agents SDK by method name, so it
   * must stay public and keep this exact name). Drains staged usage
   * rows to USAGE_QUEUE in batches, deleting only what the queue
   * accepted, and reschedules itself while a backlog remains — on a
   * longer horizon after a send failure so a down queue can't spin the
   * DO awake. Rows survive a cut-short drain, so nothing is lost.
   */
  async flushUsageOutbox(): Promise<void> {
    const sql = this.ctx.storage.sql
    ensureOutboxTable(sql)
    try {
      const { remaining } = await drainOutbox(sql, this.env.USAGE_QUEUE)
      if (remaining > 0) {
        await this.schedule(USAGE_DRAIN_DELAY_SECONDS, 'flushUsageOutbox', undefined, {
          idempotent: true
        })
      }
    } catch (err) {
      console.error(`[usage] outbox drain failed: ${stringifyError(err)}`)
      await this.schedule(USAGE_DRAIN_RETRY_SECONDS, 'flushUsageOutbox', undefined, {
        idempotent: true
      })
    }
  }
}

// ----- helpers ------------------------------------------------------------

function errText(msg: string) {
  return { isError: true, content: [{ type: 'text' as const, text: msg }] }
}

function safeJson(v: unknown): string {
  try {
    return typeof v === 'string' ? v : JSON.stringify(v ?? null)
  } catch {
    return ''
  }
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
