/**
 * `/mcp` — one endpoint, two lanes.
 *
 * Every request is classified by protocol era and sent to the lane that
 * speaks it:
 *
 *   - **stateless lane** — protocol revision 2026-07-28 (the per-request
 *     envelope; no `initialize`, no session). A fresh server per request,
 *     built by `statelessServerFactory`, served by the agents SDK's
 *     `createMcpHandler` in strict mode (`legacy: 'reject'`).
 *   - **session lane** — everything 2025-era: `initialize`, requests carrying
 *     an `Mcp-Session-Id`, the GET stream, DELETE. Served, unchanged, by
 *     `McpSessionDO` (one Durable Object per MCP session).
 *
 * The two coexist deliberately and indefinitely: 2025-era clients are not
 * assumed to work against a stateless server, so they are never routed to
 * one. The split is the SDK's own predicate, `isLegacyRequest` — the same
 * classification `createMcpHandler` applies internally — so a request the
 * modern path should answer (including its validation errors) never reaches
 * the session lane, and vice versa.
 *
 * The session lane's handler is passed in rather than imported: it pulls in
 * `McpAgent`, which cannot load under vitest, and this module must stay
 * testable end to end.
 */

import { createMcpHandler } from 'agents/mcp/server'
import { isLegacyRequest } from '@modelcontextprotocol/server'
import type { Env } from '../../env'
import { statelessServerFactory, type StatelessDeps } from './build-server'

/** The fetch shape `OAuthProvider` expects of an `apiHandlers` entry. */
export interface LaneHandler {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response>
}

/**
 * Kill switch. The stateless lane is ON unless `MCP_STATELESS_LANE` is
 * `off` / `0` / `false`, in which case every request goes to the session
 * lane exactly as before the stateless lane existed — a 2026-07-28 client
 * then gets the session lane's rejection and falls back to `initialize`.
 */
export function statelessLaneEnabled(env: Pick<Env, 'MCP_STATELESS_LANE'>): boolean {
  const v = (env.MCP_STATELESS_LANE ?? '').trim().toLowerCase()
  return v !== 'off' && v !== '0' && v !== 'false'
}

/** Hosts this deployment answers MCP on (the handler validates `Host`). */
function mcpHostnames(env: Pick<Env, 'MCP_PUBLIC_URL' | 'PUBLIC_BASE_URL'>): string[] {
  const hosts = new Set<string>()
  for (const url of [env.MCP_PUBLIC_URL, env.PUBLIC_BASE_URL]) {
    if (!url) continue
    try {
      hosts.add(new URL(url).hostname)
    } catch {
      // A malformed base URL is caught elsewhere; nothing to allow here.
    }
  }
  return [...hosts]
}

export function mcpLaneRouter(sessionLane: LaneHandler, deps: StatelessDeps = {}): LaneHandler {
  return {
    async fetch(request, env, ctx) {
      if (!statelessLaneEnabled(env)) return sessionLane.fetch(request, env, ctx)
      // Classification reads the body, so it gets its own copy.
      if (await isLegacyRequest(request.clone())) return sessionLane.fetch(request, env, ctx)

      // Built per request, like the OAuth provider that calls us: the factory
      // closes over `env`, which only exists per invocation.
      const stateless = createMcpHandler(statelessServerFactory(env, deps), {
        route: '/mcp',
        // Strict: this lane answers 2026-07-28 only. Legacy traffic was
        // routed away above; anything that still arrives here claiming an
        // older era gets the spec's unsupported-version answer.
        legacy: 'reject',
        allowedHostnames: mcpHostnames(env),
        // The endpoint is bearer-token authenticated and sets no cookies, so
        // a browser Origin gains nothing by being on a list — and the
        // session lane never restricted it. Machine clients send no Origin.
        allowedOriginHostnames: '*'
      })
      return stateless(request, env, ctx)
    }
  }
}
