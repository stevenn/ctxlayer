/**
 * Per-session MCP server, extending `McpAgent` from the agents SDK — the
 * SESSION lane of `/mcp` (2025-era clients; one Durable Object per MCP
 * session).
 *
 * What lives here is what needs the session: the lifecycle gate, the
 * per-session `instructions`, usage staging in the DO's SQLite outbox, the
 * upstream proxy registry, and `reload_upstreams`. The built-in tools
 * themselves are lane-neutral definitions in `mcp/builtins/`, shared with
 * the stateless lane.
 *
 * Per-request props (set by `provider.completeAuthorization` in the
 * IdP callback) arrive on `this.props` — see `Env.McpProps`.
 */

import { McpAgent } from 'agents/mcp'
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Env, McpProps } from '../env'
import { findById } from '../db/queries/users'
import { UpstreamProxyRegistry } from './proxy-registry'
import {
  connectionAlert,
  loadUserContext,
  upstreamGuidance,
  type UpstreamUserContext
} from './catalogue-views'
import {
  SERVER_INSTRUCTIONS,
  alertBudget,
  composeInstructions,
  guidanceBudget
} from './server-instructions'
import { getUserCredentialStatuses } from '../db/queries/upstream-credentials'
import { registerSkillPrompts, registerSkillResources } from './skill-mcp'
import { RELOAD_UPSTREAMS_POSITION, SHARED_BUILTINS } from './builtins'
import { registerBuiltinsV1 } from './builtins/register-v1'
import { builtinRecorder } from './builtins/recorder'
import { registerDocResource } from './doc-resource'
import { registerDraftSkillPrompt } from './draft-skill-prompt'
import { surfaceOf } from './surface'
import { sqliteHintLedger } from './hint-ledger'
import { buildUsageMsg, type RecordUsageArgs } from '../usage/record'
import type { UsageOrigin } from '../usage/event'
import { ensureOutboxTable, stageUsageRow, drainOutbox } from '../usage/outbox'
import { builtinToolMeta } from '@ctxlayer/shared'
import { errMessage } from '../util/errors'
import { spaUrl, UPSTREAMS_PAGE } from '../util/spa-url'
import { errText, } from './tool-result'

// Usage-outbox drain cadence. Staged usage rows are flushed to
// USAGE_QUEUE by `flushUsageOutbox` on a short, coalesced delay so a
// burst of tool calls in a session shares one drain (the schedule is
// idempotent on callback). Rescheduled on a longer horizon after a
// queue-send failure so a down queue can't spin the DO awake.
const USAGE_DRAIN_DELAY_SECONDS = 5
const USAGE_DRAIN_RETRY_SECONDS = 30

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

    // Per-session server `instructions`: any *whole-upstream* skill/doc
    // attachments named explicitly, THEN the static base. Those
    // attachments (e.g. the "linear-practices" doc) encode org
    // conventions the upstream tool schemas don't show; naming them
    // here means the agent sees the obligation on connect instead of
    // having to discover it via `list_upstreams` + a follow-up fetch.
    // Order is connection alert → guidance → static base, because clients
    // truncate long instructions (size-budget note in
    // server-instructions.ts) and a trailing tail is precisely the part
    // that gets cut: a stopped upstream outranks a playbook pointer, which
    // outranks the standing description of the surface.
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
        upstreamCtx = await loadUserContext(this.env, userId)
        // GATEWAY_ALIAS ties the connector name the org configured
        // client-side ("Yuki MCP") to the "ctxlayer" self-identification,
        // so client-side org instructions referencing the alias bind.
        const alias = this.env.GATEWAY_ALIAS
        // Connection health leads (see `connectionAlert`): an upstream whose
        // auto-refresh has stopped is otherwise silent — its tools register
        // from the catalogue and only fail when called — and instructions are
        // the only channel a client reads unprompted.
        const creds = await getUserCredentialStatuses(
          this.env,
          userId,
          upstreamCtx.rows.map((r) => r.id)
        )
        const alert = connectionAlert(
          {
            rows: upstreamCtx.rows,
            creds,
            upstreamsUrl: spaUrl(this.env, UPSTREAMS_PAGE)
          },
          alertBudget(alias)
        )
        const guidance = upstreamGuidance(upstreamCtx, guidanceBudget(alias, alert.length))
        if (alert || guidance || (alias ?? '').trim()) {
          this.server = new McpServer(
            { name: 'ctxlayer', version: '0.1.0' },
            { instructions: composeInstructions({ alert, guidance, alias }) }
          )
        }
      } catch (err) {
        console.error('server-instructions guidance build failed:', err)
      }
    }

    // Usage recorder for built-in tools: the shared recorder, sinking into
    // this session's DO outbox.
    const rec = builtinRecorder(
      (args) => this.stageUsage(args),
      () => ({ userId: this.props?.userId ?? '', sessionId: this.getSessionId() })
    )

    // Built-in tools. Their schemas + handlers are lane-neutral definitions
    // in `mcp/builtins/` (shared with the stateless lane); title + description
    // come from `packages/shared/src/builtin-tools.ts` via `builtinToolMeta`,
    // so what the agent sees and what `/api/tools` lists can't drift. This
    // lane contributes only the usage recorder (`rec`) and the caller.
    // `reload_upstreams` is this lane's own — it mutates the live registry —
    // and is registered at its place in the list so `tools/list` order holds.
    const builtinCall = () => ({ env: this.env, user: this.props })
    registerBuiltinsV1(
      this.server,
      SHARED_BUILTINS.slice(0, RELOAD_UPSTREAMS_POSITION),
      builtinCall,
      rec
    )

    this.server.registerTool('reload_upstreams', { ...builtinToolMeta('reload_upstreams') }, () =>
      rec('reload_upstreams', undefined, async () => {
        const userId = this.props?.userId
        if (!userId) return errText('not_signed_in')
        // Re-hydrate on the LIVE server so an upstream connected after this
        // session's init becomes callable without a client reconnect. If the
        // proxy registry failed to build at init (or there were no upstreams
        // then), build one now so a first-ever upstream still surfaces.
        if (!this.upstreamProxy) {
          this.upstreamProxy = new UpstreamProxyRegistry(
            this.env,
            userId,
            (args) => this.stageUsage(args),
            this.getSessionId(),
            undefined,
            sqliteHintLedger(this.ctx.storage.sql)
          )
        }
        const { added, recovered, unbound, loaded } = await this.upstreamProxy.refresh(this.server)
        // Say what actually happened. The old "Nothing new…" branch was wrong
        // in the one case people call this for: the DO had hibernated, its
        // wake re-ran init() (which bound the freshly connected upstream),
        // and the diff against that new instance came back empty.
        const notes: string[] = []
        if (added.length > 0) {
          notes.push(
            `Registered new upstream tools: ${added.map((a) => `${a.slug} (+${a.tools})`).join(', ')}.`
          )
        }
        if (recovered.length > 0) {
          notes.push(`Re-bound after re-authorization — callable again: ${recovered.join(', ')}.`)
        }
        if (unbound.length > 0) {
          notes.push(
            `Still without a usable credential: ${unbound.join(', ')}. Their tools stay listed, ` +
              `but every call fails until the user re-authorizes them at ` +
              `${spaUrl(this.env, UPSTREAMS_PAGE)}; after that, just retry the call.`
          )
        }
        if (notes.length === 0) {
          notes.push(
            'No change in this call: every upstream this user can use was already bound and ' +
              'every catalogued tool already listed.'
          )
        }
        notes.push(
          'Sent tools/list_changed so your client re-reads the tool list (if it does not honor ' +
            'that, reconnect the connector). list_upstreams has the per-upstream status.'
        )
        const body = {
          added,
          recovered,
          needsReauthorization: unbound,
          loadedUpstreams: loaded,
          note: notes.join(' ')
        }
        return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] }
      })
    )

    registerBuiltinsV1(
      this.server,
      SHARED_BUILTINS.slice(RELOAD_UPSTREAMS_POSITION),
      builtinCall,
      rec
    )

    // ----- prompts + resources -----
    // Written once against `McpSurface` (shared with the stateless lane) and
    // registered here on this lane's SDK v1 server: skill resources
    // (mcp://ctxlayer/skills/{slug} + the SEP-2640 set), one prompt per
    // published skill — registered before /draft-skill, whose reserved name
    // `skillPromptEntries` skips — and the /draft-skill prompt. The doc
    // resource follows the upstream tools below.
    const surface = surfaceOf(this.server, ResourceTemplate)
    const getUserId = () => this.props?.userId
    registerSkillResources(surface, this.env)
    await registerSkillPrompts(surface, this.env, getUserId)
    registerDraftSkillPrompt(surface, this.env, getUserId)

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
          this.getSessionId(),
          undefined,
          // Durable once-per-session hint state — the DO hibernates
          // between requests, so it cannot live on the registry instance.
          sqliteHintLedger(this.ctx.storage.sql),
          undefined,
          () => this.usageOrigin()
        )
        await this.upstreamProxy.init(this.server, upstreamCtx ?? undefined)
      } catch (err) {
        console.error('upstream proxy init failed:', err)
        this.upstreamProxy = null
      }
    }

    registerDocResource(surface, this.env)
  }

  /**
   * This session's lane + client identity for the usage pages. The lane is
   * `session` by definition; the protocol revision and client name come from
   * the `initialize` request the agents SDK persists for this session (so
   * they survive hibernation, unlike anything held on the instance). Read
   * failures degrade to "lane only" — usage must never fail a tool call.
   */
  private async usageOrigin(): Promise<UsageOrigin> {
    try {
      const init = (await this.getInitializeRequest()) as
        | { params?: { protocolVersion?: unknown; clientInfo?: { name?: unknown } } }
        | undefined
      const requested = init?.params?.protocolVersion
      return {
        lane: 'session',
        protocolVersion: typeof requested === 'string' ? requested.slice(0, 32) : null,
        clientName:
          this.server.server.getClientVersion()?.name ??
          (typeof init?.params?.clientInfo?.name === 'string' ? init.params.clientInfo.name : null)
      }
    } catch {
      return { lane: 'session' }
    }
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
      const origin = args.origin ?? (await this.usageOrigin())
      stageUsageRow(this.ctx.storage.sql, buildUsageMsg({ ...args, origin }))
      await this.schedule(USAGE_DRAIN_DELAY_SECONDS, 'flushUsageOutbox', undefined, {
        idempotent: true
      })
    } catch (err) {
      console.error(`[usage] stage failed for ${args.tool}: ${errMessage(err)}`)
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
      console.error(`[usage] outbox drain failed: ${errMessage(err)}`)
      await this.schedule(USAGE_DRAIN_RETRY_SECONDS, 'flushUsageOutbox', undefined, {
        idempotent: true
      })
    }
  }
}

// ----- helpers ------------------------------------------------------------



