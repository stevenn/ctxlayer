/**
 * Proxied upstream tools on the stateless lane.
 *
 * The session lane's `UpstreamProxyRegistry` prepares every upstream once per
 * session and keeps clients, credential stamps and an ACL set in memory.
 * Nothing survives between requests here, so each request does only its own
 * work, fresh:
 *
 *   - `tools/list` → `registerUpstreamToolList`: every tool the caller may
 *     call, from the cached catalogue. No bearer is resolved and no upstream
 *     is dialled unless a catalogue is stale.
 *   - `tools/call` → `registerUpstreamToolForCall`: the ONE tool named, after
 *     the same two gates as everywhere else (upstream visibility, then
 *     per-tool ACL). A tool the caller may not use is simply not registered,
 *     so the SDK answers exactly as it does for a tool that does not exist.
 *
 * The call itself goes through the same helpers as the session lane
 * (`runUpstreamCall`, the sanitisers and scrubbers behind it, async submit,
 * credential freshness), so results and errors read the same on both lanes.
 */

import { fromJsonSchema, type McpServer } from '@modelcontextprotocol/server'
import { isToolAllowed } from '@ctxlayer/shared'
import type { Env } from '../../env'
import { claimHint } from '../../db/queries/hint-ledger'
import { listDocsForUpstreams } from '../../db/queries/doc-attachments'
import { listSkillsForUpstreams } from '../../db/queries/skill-attachments'
import {
  accessKey,
  indexToolAccess,
  listToolAccessForUpstreams,
  resolveUserPrincipals
} from '../../db/queries/tool-access'
import {
  getUserCredentialStatus,
  getUserCredentialStatuses
} from '../../db/queries/upstream-credentials'
import {
  listCachedTools,
  listCachedToolsForUpstreams,
  type UpstreamToolRow
} from '../../db/queries/upstream-tools'
import {
  listUpstreamsVisibleToUser,
  toUpstreamConnection,
  type UpstreamConnection,
  type UpstreamServerRow
} from '../../db/queries/upstreams'
import { resolveUserUpstreamBearer } from '../../upstream/bearer'
import { createUpstreamClient } from '../../upstream/create-client'
import { classifyUpstreamError, scrubErrorForStorage } from '../../usage/error-detail'
import type { UsageOrigin } from '../../usage/event'
import { errMessage } from '../../util/errors'
import { spaUrl, UPSTREAMS_PAGE } from '../../util/spa-url'
import { isAsyncTool, submitAsyncJob } from '../async-submit'
import { ensureFreshCatalogue, isCatalogueStale } from '../catalogue-cache'
import { firstResultHint, perToolPointers, type UpstreamUserContext } from '../catalogue-views'
import { checkCredentialFreshness } from '../credential-freshness'
import { cachedInputSchema, proxiedToolDescription, withFirstResultHint } from '../proxied-tool'
import { mangleToolName } from '../tool-name'
import { errText, safeJson } from '../tool-result'
import { callWithHeartbeat, runUpstreamCall, type ProxyToolExtra } from '../upstream-call-runner'
import { sendUsage } from './usage'

/**
 * How long after a first-result hint the same (user, client, upstream) is
 * hinted again. The session lane hints once per MCP session; with no session
 * to count, half a day approximates "the next time they sit down to work".
 */
export const HINT_REARM_SECONDS = 12 * 60 * 60

/** Who is calling and where the call is recorded. One per request. */
export interface UpstreamLane {
  env: Env
  userId: string
  /** Stable per (user, client) — see `sessionKeyFor`. */
  sessionKey: string
  origin: UsageOrigin
  /** Injectable so tests can substitute a fake transport. */
  makeClient?: typeof createUpstreamClient
}

/** The slice of the SDK's per-call context the proxy uses. */
interface CallCtx {
  mcpReq: {
    _meta?: { progressToken?: string | number }
    notify: (n: { method: string; params?: unknown }) => Promise<void>
  }
}

function safeConnection(row: UpstreamServerRow): UpstreamConnection | null {
  try {
    return toUpstreamConnection(row)
  } catch {
    return null
  }
}

function isUserScoped(conn: { authStrategy: string }): boolean {
  return conn.authStrategy === 'user_bearer' || conn.authStrategy === 'user_oauth'
}

/**
 * Register every upstream tool the caller may call, for `tools/list`.
 *
 * An upstream is listed when the caller could plausibly call it: it needs no
 * per-user credential, or the caller has one on file — even a dead one, so
 * its tools fail loudly with recovery text instead of silently vanishing (the
 * session lane's rule). A user who never connected an upstream gets nothing
 * listed for it.
 */
export async function registerUpstreamToolList(
  server: McpServer,
  lane: UpstreamLane,
  ctx: UpstreamUserContext,
  onCall?: (ctx: unknown) => void
): Promise<void> {
  const { env, userId } = lane
  const conns = ctx.rows.flatMap((row) => {
    const conn = safeConnection(row)
    return conn ? [{ row, conn }] : []
  })
  if (conns.length === 0) return
  const ids = conns.map((c) => c.conn.id)
  const [principals, aclRows, cachedByUpstream, creds] = await Promise.all([
    resolveUserPrincipals(env, userId),
    listToolAccessForUpstreams(env, ids),
    listCachedToolsForUpstreams(env, ids),
    getUserCredentialStatuses(env, userId, ids)
  ])
  const acl = indexToolAccess(aclRows)
  const listable = conns.filter(
    ({ conn }) => !isUserScoped(conn) || creds.get(conn.id)?.present === true
  )
  // Catalogues are served from the cache; only a stale or empty one costs a
  // bearer resolve + a live `tools/list`, within the shared refresh budget.
  // Refreshes run concurrently; a failure degrades only that upstream.
  const catalogues = await Promise.all(
    listable.map(({ row, conn }) =>
      catalogueFor(lane, row, conn, cachedByUpstream.get(conn.id) ?? []).catch((err) => {
        console.error(`[stateless] ${conn.slug}: catalogue failed: ${errMessage(err)}`)
        return cachedByUpstream.get(conn.id) ?? []
      })
    )
  )
  // Registration is sequential, in visibility order, so `tools/list` is
  // deterministic.
  listable.forEach(({ row, conn }, i) => {
    const perTool = perToolPointers(
      ctx.skillsByUpstream.get(conn.id) ?? [],
      ctx.docsByUpstream.get(conn.id) ?? []
    )
    for (const tool of catalogues[i] ?? []) {
      if (!isToolAllowed(acl.get(accessKey(conn.id, tool.tool_name)), principals)) continue
      registerProxiedTool(server, lane, row, conn, tool, perTool.get(tool.tool_name) ?? [], onCall)
    }
  })
}

async function catalogueFor(
  lane: UpstreamLane,
  row: UpstreamServerRow,
  conn: UpstreamConnection,
  cached: UpstreamToolRow[]
): Promise<UpstreamToolRow[]> {
  if (!isCatalogueStale(cached)) return cached
  const bearer = await resolveUserUpstreamBearer(lane.env, row, conn, lane.userId)
  if (conn.authStrategy !== 'none' && bearer === null) return cached // nothing to dial with
  const client = (lane.makeClient ?? createUpstreamClient)(conn, bearer)
  try {
    return await ensureFreshCatalogue(lane.env, conn, client, cached)
  } finally {
    await client.close().catch(() => {})
  }
}

/**
 * Register the one upstream tool a `tools/call` names — if, and only if, the
 * caller may call it. Returns false (registering nothing) when the name is
 * not an upstream tool the caller can reach; an ungranted upstream, a tool
 * hidden by ACL and a name that never existed are deliberately
 * indistinguishable from here on.
 */
export async function registerUpstreamToolForCall(
  server: McpServer,
  lane: UpstreamLane,
  mangledName: string,
  onCall?: (ctx: unknown) => void
): Promise<boolean> {
  const { env, userId } = lane
  const sep = mangledName.indexOf('__')
  if (sep <= 0) return false
  const slug = mangledName.slice(0, sep)
  // Gate 1: visibility. Never a bare by-slug lookup.
  const row = (await listUpstreamsVisibleToUser(env, userId)).find((r) => r.slug === slug)
  if (!row) return false
  const conn = safeConnection(row)
  if (!conn) return false
  const [cached, principals, aclRows, cred] = await Promise.all([
    listCachedTools(env, conn.id),
    resolveUserPrincipals(env, userId),
    listToolAccessForUpstreams(env, [conn.id]),
    isUserScoped(conn) ? getUserCredentialStatus(env, userId, conn.id) : null
  ])
  // Same listing rule as `tools/list`: no credential on file = not theirs.
  if (cred && !cred.present) return false
  // The mangled name can drop a redundant slug prefix, so it does not
  // round-trip; match it against each cached tool's own mangled name.
  const tool = cached.find((t) => mangleToolName(conn.slug, t.tool_name) === mangledName)
  if (!tool) return false
  // Gate 2: per-tool ACL.
  const acl = indexToolAccess(aclRows)
  if (!isToolAllowed(acl.get(accessKey(conn.id, tool.tool_name)), principals)) {
    console.warn(`[tool-acl] blocked ${conn.slug}.${tool.tool_name} for user ${userId}`)
    return false
  }
  registerProxiedTool(server, lane, row, conn, tool, [], onCall)
  return true
}

function registerProxiedTool(
  server: McpServer,
  lane: UpstreamLane,
  row: UpstreamServerRow,
  conn: UpstreamConnection,
  tool: UpstreamToolRow,
  pointers: string[],
  onCall?: (ctx: unknown) => void
): void {
  const mangled = mangleToolName(conn.slug, tool.tool_name)
  // The upstream's own JSON Schema is advertised verbatim (and validated
  // against by the SDK) — v2 needs no conversion to zod.
  const inputSchema = fromJsonSchema(cachedInputSchema(tool) as Parameters<typeof fromJsonSchema>[0])
  const register = server.registerTool.bind(server) as unknown as (
    name: string,
    config: { title: string; description: string; inputSchema: unknown },
    cb: (args: unknown, ctx: CallCtx) => unknown
  ) => unknown
  register(
    mangled,
    // title = mangled so the human-facing label matches the agent-callable
    // name (and surfaces the upstream slug).
    { title: mangled, description: proxiedToolDescription(conn, tool, pointers), inputSchema },
    (args, ctx) => {
      // Lets the lane read the client's identity for usage before the call.
      onCall?.(ctx)
      return callProxiedTool(lane, row, conn, tool.tool_name, mangled, args, ctx)
    }
  )
}

/** One proxied call: gate, dial, run, hint, record. */
async function callProxiedTool(
  lane: UpstreamLane,
  row: UpstreamServerRow,
  conn: UpstreamConnection,
  upstreamToolName: string,
  mangled: string,
  args: unknown,
  ctx: CallCtx
) {
  const { env, userId } = lane
  const t0 = Date.now()
  const reqJson = safeJson(args)
  let status: 'ok' | 'error' | 'timeout' = 'ok'
  let truncated = false
  let respJson = ''
  // Set only on failures — a coarse class + the raw detail (scrubbed for
  // storage in the `finally`). Drives the usage error table.
  let errorCode: string | undefined
  let errorDetail: string | undefined
  try {
    // A dead or disconnected per-user credential blocks here with first-party
    // recovery text. Inside the try so the block is RECORDED: the people who
    // most need to re-authorize must show up in the Errors table.
    const fresh = await checkCredentialFreshness(env, userId, conn)
    if (fresh.error) {
      console.warn(`[cred-freshness] blocked ${conn.slug}.${upstreamToolName} for user ${userId}`)
      status = 'error'
      errorCode = 'credential_revoked'
      errorDetail = fresh.error
      return errText(fresh.error)
    }
    // Async-eligible tools run out-of-band (see mcp/async-submit.ts): enqueue
    // a job, return a token, let the jobs consumer make the real call.
    if (isAsyncTool(conn, upstreamToolName)) {
      try {
        const sub = await submitAsyncJob(
          env,
          { userId, sessionId: lane.sessionKey, origin: lane.origin },
          conn,
          upstreamToolName,
          args
        )
        respJson = sub.respJson
        return await withHintIfDue(lane, conn, sub.surface)
      } catch (err) {
        // A failed submit (D1 insert, queue send) reaches the agent as a
        // thrown error — record it as one, not as a zero-byte 'ok'.
        status = 'error'
        errorDetail = errMessage(err)
        errorCode = classifyUpstreamError('error', errorDetail)
        throw err
      }
    }
    // Resolved per call, so a credential the user just re-authorized (or
    // another request just refreshed) is what this call uses.
    const bearer = await resolveUserUpstreamBearer(env, row, conn, userId)
    if (conn.authStrategy !== 'none' && bearer === null) {
      // Credential on file and not flagged, yet no bearer came out of it:
      // its refresh failed for a (so far) transient reason. Say so — a
      // bare "not connected" reads as "reconnect the connector".
      const msg =
        `upstream_unavailable: could not establish your ${conn.slug} connection — ` +
        `refreshing its token failed just now, which is usually temporary. Nothing was ` +
        `sent to ${conn.slug}. Retry in a minute; if it keeps failing, the user should ` +
        `re-authorize it at ${spaUrl(env, UPSTREAMS_PAGE)}.`
      status = 'error'
      errorCode = 'upstream_auth'
      errorDetail = msg
      return errText(msg)
    }
    const client = (lane.makeClient ?? createUpstreamClient)(conn, bearer)
    try {
      const outcome = await runUpstreamCall({
        slug: conn.slug,
        toolName: upstreamToolName,
        upstreamUrl: conn.url,
        maxResponseBytes: conn.authConfig.maxResponseBytes,
        run: () =>
          callWithHeartbeat(heartbeatExtra(ctx), () => client.callTool(upstreamToolName, args))
      })
      respJson = outcome.respJson
      status = outcome.status
      truncated = outcome.truncated
      errorCode = outcome.errorCode
      errorDetail = outcome.errorDetail
      // First SUCCESSFUL result only: errors carry nudges/scrubbing and a
      // truncated result already carries its own first-party notice.
      if (outcome.status === 'ok' && !outcome.truncated) {
        return await withHintIfDue(lane, conn, outcome.surface)
      }
      return outcome.surface
    } finally {
      await client.close().catch(() => {})
    }
  } finally {
    await sendUsage(env, {
      userId,
      sessionId: lane.sessionKey,
      upstreamId: conn.id,
      tool: mangled,
      reqJson,
      respJson,
      latencyMs: Date.now() - t0,
      status,
      truncated,
      errorCode,
      errorMessage: errorDetail != null ? scrubErrorForStorage(errorDetail) : undefined,
      origin: lane.origin
    })
  }
}

/** Progress heartbeats ride the per-request response stream. */
function heartbeatExtra(ctx: CallCtx): ProxyToolExtra {
  return {
    _meta: ctx.mcpReq._meta,
    sendNotification: (n) => ctx.mcpReq.notify(n)
  }
}

/**
 * Append the upstream's playbook hint when one is due for this (user,
 * client, upstream). The ledger is claimed FIRST — one cheap statement that
 * usually says "not due" — so the attachment reads only happen when a hint
 * can actually be delivered. A ledger or attachment failure degrades to "no
 * hint": the hint is a nicety and must never fail a successful call.
 */
async function withHintIfDue<
  T extends { content: Array<{ type: string; text?: string }>; structuredContent?: unknown }
>(lane: UpstreamLane, conn: UpstreamConnection, surface: T): Promise<T> {
  try {
    const due = await claimHint(
      lane.env,
      { userId: lane.userId, clientKey: lane.sessionKey, upstreamId: conn.id },
      Math.floor(Date.now() / 1000),
      HINT_REARM_SECONDS
    )
    if (!due) return surface
    const [skills, docs] = await Promise.all([
      listSkillsForUpstreams(lane.env, [conn.id]),
      listDocsForUpstreams(lane.env, [conn.id])
    ])
    const hint = firstResultHint(conn.slug, skills.get(conn.id) ?? [], docs.get(conn.id) ?? [])
    return hint ? withFirstResultHint(surface, hint) : surface
  } catch (err) {
    console.error(`[stateless] ${conn.slug}: first-result hint failed: ${errMessage(err)}`)
    return surface
  }
}
