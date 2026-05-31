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
import { getDocByIdOrSlug, listDocs } from '../db/queries/docs'
import { resolveUserScope } from '../db/queries/doc-tags'
import { readSnapshot } from '../storage/docs-r2'
import { renderBlocksToMarkdown } from '../rag/markdown'
import { embed } from '../rag/embedder'
import type { ChunkMetadata } from '../rag/index'
import { UpstreamProxyRegistry } from './tools-proxy'
import { registerSkillMcp } from './skill-mcp'
import { buildUsageMsg, type RecordUsageArgs } from '../usage/record'
import { ensureOutboxTable, stageUsageRow, drainOutbox } from '../usage/outbox'

const SEARCH_K_DEFAULT = 8
const SEARCH_K_MAX = 50
// Overshoot the topK so post-filter has headroom when many chunks
// don't match the user's scope. Cap at Vectorize's max (currently 100).
const SEARCH_OVERSHOOT = 3
const VECTORIZE_TOPK_MAX = 100

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
    if (userId) {
      try {
        const guidance = await UpstreamProxyRegistry.upstreamGuidance(this.env, userId)
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
      const finalize = (respJson: string, status: 'ok' | 'error') =>
        this.stageUsage({
          userId,
          sessionId,
          upstreamId: null,
          tool,
          reqJson,
          respJson,
          latencyMs: Date.now() - t0,
          status
        })
      return exec().then(
        async (result) => {
          await finalize(safeJson(result.content), result.isError ? 'error' : 'ok')
          return result
        },
        async (err) => {
          await finalize(stringifyError(err), 'error')
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
          'Returns the teams + products the caller belongs to (transitively via team membership), the accessible upstream MCP servers, and the default search scope that `search_docs` will use when no scope is supplied.'
      },
      () =>
        rec('list_my_context', undefined, async () => {
          const userId = this.props?.userId
          if (!userId) return errText('not_signed_in')
          const [scope, accessibleUpstreams] = await Promise.all([
            resolveUserScope(this.env, userId),
            UpstreamProxyRegistry.accessibleSlugs(this.env, userId)
          ])
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    teams: scope.teams,
                    products: scope.products,
                    accessibleUpstreams,
                    defaultScope: scope
                  },
                  null,
                  2
                )
              }
            ]
          }
        })
    )

    this.server.registerTool(
      'list_upstreams',
      {
        title: 'List upstreams',
        description:
          'Lists the upstream MCP servers visible to the caller, with connected state, transport, and cached tool count. Disconnected upstreams point the user at /upstreams to paste a token.'
      },
      () =>
        rec('list_upstreams', undefined, async () => {
          const userId = this.props?.userId
          if (!userId) return errText('not_signed_in')
          const entries = await UpstreamProxyRegistry.listUpstreamsForUser(this.env, userId)
          return {
            content: [{ type: 'text', text: JSON.stringify(entries, null, 2) }]
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
          'Semantic search over the org-curated doc library. Defaults to the caller\'s teams + products + globally-tagged docs. Pass `scope: "all"` to remove the filter, or `scope: { teams: [...], products: [...] }` to intersect with the caller\'s reachable set (no escalation).',
        inputSchema: {
          query: z.string().min(1),
          k: z.number().int().min(1).max(SEARCH_K_MAX).optional(),
          scope: z
            .union([
              z.literal('all'),
              z.object({
                teams: z.array(z.string()).optional(),
                products: z.array(z.string()).optional()
              })
            ])
            .optional()
        }
      },
      (args) =>
        rec('search_docs', args, async () => {
          const { query, k, scope } = args
          const userId = this.props?.userId
          if (!userId) return errText('not_signed_in')
          const limit = k ?? SEARCH_K_DEFAULT

          // Embed the query (one-element batch).
          const { vectors } = await embed(this.env, [query])
          const qvec = vectors[0]
          if (!qvec) return errText('embedding_failed')

          // Resolve the caller's effective scope.
          const userScope = await resolveUserScope(this.env, userId)
          const effective = effectiveScope(scope, userScope)

          // Overshoot topK to give post-filter room, capped at Vectorize's max.
          const topK = Math.min(limit * SEARCH_OVERSHOOT, VECTORIZE_TOPK_MAX)
          const result = await this.env.DOCS_INDEX.query(qvec, {
            topK,
            returnMetadata: 'all'
          })

          const matches = (result.matches ?? [])
            .map((m) => ({ ...m, metadata: m.metadata as unknown as ChunkMetadata }))
            .filter((m) => passesScope(m.metadata, effective))
            .slice(0, limit)
            .map((m) => ({
              docId: m.metadata.docId,
              chunkIdx: m.metadata.chunkIdx,
              title: m.metadata.title,
              headings: m.metadata.headings,
              score: m.score,
              snippet: truncate(m.metadata.text, 600)
            }))

          return {
            content: [{ type: 'text', text: JSON.stringify({ matches }, null, 2) }]
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
            description: `${d.slug} (${d.kind})`,
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
        await this.upstreamProxy.init(this.server)
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

interface EffectiveScope {
  teams: string[]
  products: string[]
  includeGlobal: boolean
  /** When true, skip all metadata filtering. */
  all: boolean
}

function effectiveScope(
  scope: 'all' | { teams?: string[]; products?: string[] } | undefined,
  user: { teams: string[]; products: string[] }
): EffectiveScope {
  if (scope === 'all') return { teams: [], products: [], includeGlobal: true, all: true }
  if (!scope) {
    return { teams: user.teams, products: user.products, includeGlobal: true, all: false }
  }
  // Intersect supplied scope with user's reachable set so a caller
  // can't escalate. Asked but not allowed → silently dropped.
  const teams = (scope.teams ?? user.teams).filter((t) => user.teams.includes(t))
  const products = (scope.products ?? user.products).filter((p) => user.products.includes(p))
  return { teams, products, includeGlobal: true, all: false }
}

function passesScope(m: ChunkMetadata, scope: EffectiveScope): boolean {
  if (scope.all) return true
  if (scope.includeGlobal && m.is_global) return true
  if (m.tag_teams.some((t) => scope.teams.includes(t))) return true
  if (m.tag_products.some((p) => scope.products.includes(p))) return true
  return false
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n - 1) + '…'
}

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

