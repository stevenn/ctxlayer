/**
 * The stateless lane's per-request server factory.
 *
 * `createMcpHandler` calls this once for every request and serves that one
 * request from the server it returns — there is no session and nothing is
 * kept between calls. Everything the session lane does once at `init()` is
 * therefore done here per request, but only for the part of the surface the
 * request addresses (`request-scope.ts`), and always against current state:
 * the account's status, the upstream catalogue, credentials.
 */

import { getMcpAuthContext } from 'agents/mcp/server'
import {
  McpServer,
  ResourceTemplate,
  type McpRequestContext,
  type McpServerFactory
} from '@modelcontextprotocol/server'
import type { Env, McpProps } from '../../env'
import { getUserCredentialStatuses } from '../../db/queries/upstream-credentials'
import { findById } from '../../db/queries/users'
import type { createUpstreamClient } from '../../upstream/create-client'
import { cleanClientName, type UsageOrigin } from '../../usage/event'
import { spaUrl, UPSTREAMS_PAGE } from '../../util/spa-url'
import { RELOAD_UPSTREAMS_POSITION, SHARED_BUILTINS } from '../builtins'
import { builtinRecorder } from '../builtins/recorder'
import { registerBuiltinsV2 } from '../builtins/register-v2'
import { connectionAlert, loadUserContext, upstreamGuidance } from '../catalogue-views'
import { registerDocResource } from '../doc-resource'
import { registerDraftSkillPrompt } from '../draft-skill-prompt'
import {
  SERVER_INSTRUCTIONS,
  alertBudget,
  composeInstructions,
  guidanceBudget
} from '../server-instructions'
import { registerSkillPrompts, registerSkillResources } from '../skill-mcp'
import { SKILLS_EXTENSION_ID } from '../skill-sep2640'
import { surfaceOf } from '../surface'
import { reloadUpstreamsStateless } from './reload-upstreams'
import { requestScope, type RequestScope } from './request-scope'
import { registerUpstreamToolForCall, registerUpstreamToolList } from './upstream-tools'
import { sendUsage, sessionKeyFor } from './usage'

const SERVER_INFO = { name: 'ctxlayer', version: '0.1.0' }

/** The only protocol revision this lane serves. */
export const STATELESS_PROTOCOL_VERSION = '2026-07-28'

/**
 * Advertised on every request, registered or not: a `server/discover` builds
 * no tools/prompts/resources, yet must still say the server has them.
 */
const CAPABILITIES = {
  tools: {},
  prompts: {},
  resources: {},
  extensions: { [SKILLS_EXTENSION_ID]: {} }
}

const BUILTINS = [
  ...SHARED_BUILTINS.slice(0, RELOAD_UPSTREAMS_POSITION),
  reloadUpstreamsStateless,
  ...SHARED_BUILTINS.slice(RELOAD_UPSTREAMS_POSITION)
]
const BUILTIN_NAMES = new Set(BUILTINS.map((t) => t.name))

export interface StatelessDeps {
  /** Injectable so tests can substitute a fake upstream transport. */
  makeClient?: typeof createUpstreamClient
}

export function statelessServerFactory(env: Env, deps: StatelessDeps = {}): McpServerFactory {
  return async (ctx: McpRequestContext) => {
    const props = getMcpAuthContext()?.props as McpProps | undefined
    const userId = props?.userId
    const scope = requestScope(ctx.requestInfo)

    // Lifecycle gate, on EVERY request: a suspended or deleted account gets
    // an empty surface immediately, without waiting for its session to end
    // or its grant to be revoked.
    if (userId) {
      const account = await findById(env, userId)
      if (!account || account.status !== 'active') {
        return new McpServer(SERVER_INFO, {
          instructions: 'Your ctxlayer access is not active. Contact your workspace admin.'
        })
      }
    }

    const server = new McpServer(SERVER_INFO, {
      capabilities: CAPABILITIES,
      instructions: await instructionsFor(env, userId, scope)
    })
    if (scope.family === 'discover') return server

    // One request = one call, so one origin object: the lane and revision are
    // known now; the client's name arrives with the call (`noteClient`).
    const origin: UsageOrigin = {
      lane: 'stateless',
      protocolVersion:
        ctx.requestInfo?.headers.get('mcp-protocol-version')?.slice(0, 32) ??
        STATELESS_PROTOCOL_VERSION,
      clientName: null
    }
    const sessionKey = await sessionKeyFor(userId ?? '', ctx.authInfo?.clientId ?? '')
    const wants = (family: RequestScope['family']) =>
      scope.family === 'all' || scope.family === family

    if (wants('tools')) {
      const callingUpstream = scope.toolName != null && !BUILTIN_NAMES.has(scope.toolName)
      // Built-ins are free to register (no I/O), so they are always present
      // for a tools request — except when the call names an upstream tool.
      if (!callingUpstream) {
        registerBuiltinsV2(
          server,
          BUILTINS,
          () => ({ env, user: props }),
          builtinRecorder(
            (args) => sendUsage(env, { ...args, origin }),
            () => ({ userId: userId ?? '', sessionId: sessionKey })
          ),
          (callCtx) => noteClient(origin, callCtx)
        )
      }
      if (userId && (scope.toolName == null || callingUpstream)) {
        const lane = { env, userId, sessionKey, origin, makeClient: deps.makeClient }
        try {
          if (scope.toolName != null) {
            await registerUpstreamToolForCall(server, lane, scope.toolName, (callCtx) =>
              noteClient(origin, callCtx)
            )
          } else {
            await registerUpstreamToolList(
              server,
              lane,
              await loadUserContext(env, userId),
              (callCtx) => noteClient(origin, callCtx)
            )
          }
        } catch (err) {
          // Best-effort, as on the session lane: an upstream failure must not
          // take the built-ins down with it.
          console.error('[stateless] upstream tools failed:', err)
        }
      }
    }

    if (wants('prompts') || wants('resources')) {
      const surface = surfaceOf(server, ResourceTemplate)
      const getUserId = () => userId
      if (wants('resources')) {
        registerSkillResources(surface, env)
        registerDocResource(surface, env)
      }
      if (wants('prompts')) {
        // Skill prompts first: `skillPromptEntries` skips the reserved
        // /draft-skill name, so the hand-registered prompt cannot collide.
        await registerSkillPrompts(surface, env, getUserId)
        registerDraftSkillPrompt(surface, env, getUserId)
      }
    }
    return server
  }
}

/**
 * Server `instructions`: connection alert → org playbook guidance → static
 * base (see `server-instructions.ts` for the ordering and the size budget).
 * They only travel on `server/discover`, so the per-user composition — three
 * D1 reads — is skipped for every other request.
 */
async function instructionsFor(
  env: Env,
  userId: string | undefined,
  scope: RequestScope
): Promise<string> {
  if (!userId || (scope.family !== 'discover' && scope.family !== 'all')) {
    return SERVER_INSTRUCTIONS
  }
  try {
    const ctx = await loadUserContext(env, userId)
    const alias = env.GATEWAY_ALIAS
    const creds = await getUserCredentialStatuses(
      env,
      userId,
      ctx.rows.map((r) => r.id)
    )
    const alert = connectionAlert(
      { rows: ctx.rows, creds, upstreamsUrl: spaUrl(env, UPSTREAMS_PAGE) },
      alertBudget(alias)
    )
    const guidance = upstreamGuidance(ctx, guidanceBudget(alias, alert.length))
    if (alert || guidance || (alias ?? '').trim()) {
      return composeInstructions({ alert, guidance, alias })
    }
  } catch (err) {
    console.error('[stateless] instructions build failed:', err)
  }
  return SERVER_INSTRUCTIONS
}

/** Record the client's self-reported name from the per-request envelope. */
function noteClient(origin: UsageOrigin, callCtx: unknown): void {
  const envelope = (callCtx as { mcpReq?: { envelope?: Record<string, unknown> } } | undefined)
    ?.mcpReq?.envelope
  const info = envelope?.['io.modelcontextprotocol/clientInfo'] as { name?: unknown } | undefined
  origin.clientName = cleanClientName(info?.name)
}
