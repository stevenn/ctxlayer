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

import { z } from 'zod'
import { McpAgent } from 'agents/mcp'
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Env, McpProps } from '../env'
import { findById } from '../db/queries/users'
import { getDocByIdOrSlug, listDocs } from '../db/queries/docs'
import { resolveUserScope } from '../db/queries/doc-tags'
import { readSnapshot } from '../storage/docs-r2'
import { renderBlocksToMarkdown } from '../rag/markdown'
import { searchDocs, effectiveScope, availableScopeFor, SEARCH_K_DEFAULT } from '../rag/search'
import { UpstreamProxyRegistry, type UpstreamUserContext } from './tools-proxy'
import { BUILTIN_INPUT_SHAPES } from './builtin-schemas'
import { listUpstreamsVisibleToUser } from '../db/queries/upstreams'
import { findJobById, listJobsForUser } from '../db/queries/async-jobs'
import { listUserRoleIds } from '../db/queries/roles'
import { activeUsers, parseActiveUsersWindow } from '../db/queries/usage-read'
import { registerSkillMcp } from './skill-mcp'
import { buildDraftContext } from '../skills/draft-context'
import {
  buildDraftSkillMessages,
  buildDraftSkillText,
  draftPromptNotice
} from '../skills/drafter-prompt'
import { saveDraftSkill, SaveDraftSkillError } from '../skills/save-draft-skill'
import { buildUsageMsg, type RecordUsageArgs } from '../usage/record'
import { errorTextFromContent, scrubErrorForStorage } from '../usage/error-detail'
import { ensureOutboxTable, stageUsageRow, drainOutbox } from '../usage/outbox'
import {
  McpMyContext,
  McpSearchResult,
  McpListUpstreamsResult,
  McpUpstreamTools,
  McpActiveUsers,
  builtinToolMeta
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
- \`describe_upstream(slug)\` — that upstream's tools by their NATIVE upstream names, grouped by family prefix, each with its callable \`<slug>__<tool>\` name + a one-line summary. Use when an upstream's mangled tool names are opaque and you need to know what it can do before calling.
- \`list_skills\` — every published skill, each carrying \`attached_to: [{ upstream_slug, tool_name }]\`.
- \`get_skill\` / resource \`mcp://ctxlayer/skills/{slug}\` — the skill body (markdown playbook).
- \`get_doc\` / \`search_docs\` / resource \`mcp://ctxlayer/docs/{id}\` — the doc library with semantic search.
- \`draft_skill\` + \`save_draft_skill\` (tools) — draft a new skill from this org's context for one or more upstreams and save it as the caller's PRIVATE draft; they then refine + share it from /app/skills. Call \`draft_skill(upstreams)\` to get the org context + drafting guidance, write the SKILL.md, then \`save_draft_skill\` to persist it. Any signed-in user can author — no admin needed. Use when the user asks you to capture a workflow or "make a skill" for how this org uses a service. (Also exposed as the \`/draft-skill\` prompt on clients that render MCP prompts.)

**When the user's request touches an upstream tool, follow this discovery order before calling:**

1. Call \`list_upstreams\` once per session to see the inventory. Note the \`attached_skills\` on the relevant upstream — those are your org's "how we do X with this service" playbooks. When an upstream's tool names are opaque, call \`describe_upstream(slug)\` for its native-named tool catalogue.
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
    //
    // `opts.usageResp` overrides the string whose bytes/tokens are counted for
    // the response (the agent still receives `result.content` verbatim). Used
    // by `poll_task` so replaying a done job's result doesn't re-bill tokens
    // the queue consumer already counted under the real upstream tool.
    const rec = <T extends { content?: unknown; isError?: boolean }>(
      tool: string,
      args: unknown,
      exec: () => Promise<T>,
      opts?: { usageResp?: (result: T) => string | undefined }
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
            opts?.usageResp?.(result) ?? safeJson(result.content),
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

    // The built-in tools' title + description are the single source in
    // `packages/shared/src/builtin-tools.ts` (BUILTIN_TOOLS), pulled in via
    // `builtinToolMeta` so what the agent sees and what `/api/tools` lists
    // can't drift. Schemas + handlers stay here.
    this.server.registerTool(
      'whoami',
      { ...builtinToolMeta('whoami') },
      () =>
        rec('whoami', undefined, async () => ({
          content: [{ type: 'text', text: JSON.stringify(this.props ?? null, null, 2) }]
        }))
    )

    this.server.registerTool(
      'list_my_context',
      { ...builtinToolMeta('list_my_context'), outputSchema: McpMyContext.shape },
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
        ...builtinToolMeta('list_upstreams'),
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
      'describe_upstream',
      {
        ...builtinToolMeta('describe_upstream'),
        inputSchema: BUILTIN_INPUT_SHAPES.describe_upstream,
        outputSchema: McpUpstreamTools.shape
      },
      (args) =>
        rec('describe_upstream', args, async () => {
          const userId = this.props?.userId
          if (!userId) return errText('not_signed_in')
          const body = await UpstreamProxyRegistry.describeUpstreamForUser(
            this.env,
            userId,
            args.slug,
            { family: args.family, query: args.query }
          )
          if (!body) return errText(`upstream not found: ${args.slug}`)
          return {
            content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
            structuredContent: body
          }
        })
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
            this.getSessionId()
          )
        }
        const { added, loaded } = await this.upstreamProxy.refresh(this.server)
        const body = {
          added,
          loadedUpstreams: loaded,
          note:
            added.length > 0
              ? 'Registered new upstream tools + emitted tools/list_changed. If your client honors it the tools appear now; if not, reconnect the connector.'
              : 'No upstream connected since this session started. If you just connected one and it still is not callable, your client did not pick up the change — reconnect the connector.'
        }
        return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] }
      })
    )

    this.server.registerTool(
      'get_doc',
      { ...builtinToolMeta('get_doc'), inputSchema: BUILTIN_INPUT_SHAPES.get_doc },
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
        ...builtinToolMeta('search_docs'),
        inputSchema: BUILTIN_INPUT_SHAPES.search_docs,
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

    this.server.registerTool(
      'active_users',
      {
        ...builtinToolMeta('active_users'),
        inputSchema: BUILTIN_INPUT_SHAPES.active_users,
        outputSchema: McpActiveUsers.shape
      },
      (args) =>
        rec('active_users', args, async () => {
          // Reads org-wide activity incl. colleagues' emails — admin-gated
          // (mirrors the admin-only `topUsers` usage query). The tool still
          // lists in /app/tools for everyone; only admins get data.
          if (this.props?.role !== 'admin') return errText('admin_only')
          const windowSeconds = parseActiveUsersWindow(args.window)
          const { since, count, users } = await activeUsers(this.env, windowSeconds)
          const body: McpActiveUsers = {
            windowSeconds,
            since,
            activeUserCount: count,
            users
          }
          return {
            content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
            structuredContent: body
          }
        })
    )

    // ----- async submit→poll built-ins -----
    // Slow upstream tools (per authConfig.asyncTools) run in the ctxlayer-jobs
    // consumer and return a job token; poll_task fetches the result once ready
    // (list_tasks recovers a lost job id). See tools-proxy.ts submitAsyncJob +
    // docs/plan/I-upstream-resilience.md §I9.
    this.server.registerTool(
      'poll_task',
      { ...builtinToolMeta('poll_task'), inputSchema: BUILTIN_INPUT_SHAPES.poll_task },
      (args) => {
        // Set only on the `done` branch: the delivered payload was already
        // billed under the real upstream tool by the queue consumer, so we
        // count a tiny marker here instead of re-billing the whole result.
        // Running/error/expired polls fall back to their (small) real content.
        let usageResp: string | undefined
        return rec(
          'poll_task',
          args,
          async () => {
            const userId = this.props?.userId
            if (!userId) return errText('not_signed_in')
            const job = await findJobById(this.env, args.job_id)
            // Same not_found for missing OR not-owned — don't leak that a job id
            // exists for another user.
            if (!job || job.user_id !== userId) return errText('not_found: no such job')
            if (job.status === 'running') {
              const elapsed = Math.floor(Date.now() / 1000) - job.created_at
              return {
                content: [
                  {
                    type: 'text',
                    text: `still_running: job ${job.id} has run ${elapsed}s. Call poll_task again in ~30s.`
                  }
                ]
              }
            }
            if (job.status === 'error') {
              return {
                isError: true,
                content: [{ type: 'text', text: job.error_detail ?? job.error_code ?? 'upstream_error' }]
              }
            }
            // done — replay the stored upstream content array verbatim. The
            // result blob is cleared ~1 day after completion (retry-warm is 15
            // min), so a very-late poll finds it gone.
            if (job.result_json == null) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `result_expired: job ${job.id} completed but its result is no longer cached (results are retained ~1 day). Re-run the tool to recompute.`
                  }
                ]
              }
            }
            let parsed: unknown
            try {
              parsed = JSON.parse(job.result_json)
            } catch {
              parsed = null
            }
            const content = (
              Array.isArray(parsed) ? parsed : [{ type: 'text', text: job.result_json ?? '' }]
            ) as Array<{ type: 'text'; text: string }>
            // Bill the delivery, not the payload (already counted on the upstream tool).
            usageResp = `delivered: '${job.tool}' result replayed to the agent (tokens billed on the upstream tool, not poll_task).`
            return { content }
          },
          { usageResp: () => usageResp }
        )
      }
    )

    this.server.registerTool('list_tasks', { ...builtinToolMeta('list_tasks') }, () =>
      rec('list_tasks', undefined, async () => {
        const userId = this.props?.userId
        if (!userId) return errText('not_signed_in')
        const jobs = await listJobsForUser(this.env, userId, 20)
        const body = jobs.map((j) => ({
          job_id: j.id,
          tool: j.tool,
          status: j.status,
          created_at: j.created_at,
          completed_at: j.completed_at
        }))
        return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] }
      })
    )

    // ----- skill MCP surface (M7a) -----
    // list_skills + get_skill tools + mcp://ctxlayer/skills/{slug}
    // resource template. Extracted to mcp/skill-mcp.ts to keep this
    // file focused on session lifecycle.
    registerSkillMcp(this.server, this.env, rec, () => this.props?.userId)

    // ----- skill drafting: /draft-skill prompt + save_draft_skill tool -----
    // In-app AI drafting with NO server-side LLM: the /draft-skill PROMPT
    // hands the connected agent this org's context bundle (buildDraftContext)
    // + the drafter guidance; the agent persists its draft through the
    // save_draft_skill TOOL. The user's own agent does the generation — the
    // MCP-native replacement for the CLI's `claude -p` drafting path.
    this.server.registerPrompt(
      'draft-skill',
      {
        title: 'Draft a skill',
        description:
          "Draft a ctxlayer skill for one or more upstreams using this org's context, then save it as your private draft. `upstreams` is a comma-separated list of slugs from list_upstreams; `intent` and `tool` are optional.",
        argsSchema: {
          upstreams: z
            .string()
            .describe('Comma-separated upstream slugs to draft against (e.g. "up-ado,up-driver").'),
          intent: z
            .string()
            .optional()
            .describe('What the skill should help with. Omit to let the model propose one.'),
          tool: z.string().optional().describe('Optional native tool name to focus the skill on.')
        }
      },
      async (args) => {
        const userId = this.props?.userId
        if (!userId) {
          return draftPromptNotice('You are not signed in to ctxlayer, so a skill cannot be drafted.')
        }
        const slugs = (args.upstreams ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
        const result = await buildDraftContext(this.env, {
          upstreamSlugs: slugs,
          toolName: args.tool || undefined,
          operatorPrompt: args.intent || null,
          userId
        })
        if (!result.ok) {
          return draftPromptNotice(
            `Could not build the draft context (${result.error}). Check the upstream slug(s) with list_upstreams and try again.`
          )
        }
        return buildDraftSkillMessages(result.bundle)
      }
    )

    // Tool twin of the /draft-skill prompt: returns the same context bundle +
    // guidance as tool content, so the flow works on clients that don't render
    // MCP prompts (e.g. Claude Desktop). Owner-scoped; the agent drafts then
    // calls save_draft_skill.
    this.server.registerTool(
      'draft_skill',
      { ...builtinToolMeta('draft_skill'), inputSchema: BUILTIN_INPUT_SHAPES.draft_skill },
      (args) =>
        rec('draft_skill', args, async () => {
          const userId = this.props?.userId
          if (!userId) return errText('not_signed_in')
          const result = await buildDraftContext(this.env, {
            upstreamSlugs: args.upstreams,
            toolName: args.tool || undefined,
            operatorPrompt: args.intent || null,
            userId
          })
          if (!result.ok) {
            return errText(
              `context_build_failed: ${result.error}. Check the upstream slug(s) with list_upstreams.`
            )
          }
          return { content: [{ type: 'text', text: buildDraftSkillText(result.bundle) }] }
        })
    )

    this.server.registerTool(
      'save_draft_skill',
      { ...builtinToolMeta('save_draft_skill'), inputSchema: BUILTIN_INPUT_SHAPES.save_draft_skill },
      (args) =>
        rec('save_draft_skill', args, async () => {
          const userId = this.props?.userId
          if (!userId) return errText('not_signed_in')
          try {
            const res = await saveDraftSkill(this.env, {
              userId,
              title: args.title,
              description: args.description,
              body: args.body,
              slug: args.slug,
              triggerText: args.triggerText,
              upstreams: args.upstreams,
              skillId: args.skillId
            })
            const warnings =
              res.lintFindings.length > 0
                ? '\n\nSchema-linter warnings (non-blocking):\n' +
                  res.lintFindings.map((f) => `- ${f.reference} (${f.kind})`).join('\n')
                : ''
            // Create vs update-in-place; when updating a PUBLISHED skill the
            // change is live to the org, so say so.
            let text: string
            if (res.created) {
              text =
                `Saved "${args.title}" as your private draft (slug: ${res.slug}). ` +
                `Refine and share it at /app/skills/${res.id}/edit.`
            } else if (res.status === 'published') {
              text =
                `Updated your PUBLISHED skill "${args.title}" (slug: ${res.slug}, now version ${res.version}). ` +
                `This change is LIVE to the org. Edit or roll back at /app/skills/${res.id}/edit.`
            } else {
              text =
                `Updated your ${res.status} skill "${args.title}" (slug: ${res.slug}, now version ${res.version}). ` +
                `Refine and share it at /app/skills/${res.id}/edit.`
            }
            return { content: [{ type: 'text', text: text + warnings }] }
          } catch (err) {
            if (err instanceof SaveDraftSkillError) return errText(err.code)
            const msg = err instanceof Error ? err.message : String(err)
            if (/UNIQUE constraint failed/i.test(msg)) return errText('slug_taken')
            console.error('save_draft_skill failed:', msg)
            return errText('save_failed')
          }
        })
    )

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
