import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider'

/**
 * Typed wrangler bindings. Anything reachable through `env` in a Worker
 * handler is declared here. Never read `process.env` — Workers don't have it.
 */
export interface Env {
  // Static vars (wrangler.toml [vars])
  PUBLIC_BASE_URL: string
  // Public base URL of the MCP surface, when it differs from PUBLIC_BASE_URL —
  // e.g. a dedicated `mcp.<tenant>` host fronting the same Worker (the browser
  // host may be fully Access-gated and thus unusable by machine MCP clients).
  // Surfaced via /api/config as `mcpBaseUrl`; empty/unset ⇒ falls back to
  // PUBLIC_BASE_URL. Not a secret; injected as a [var] by the deploy.
  MCP_PUBLIC_URL?: string
  ALLOWED_GOOGLE_HD: string
  ALLOWED_GOOGLE_EMAILS: string
  ALLOWED_GITHUB_ORG: string
  ALLOWED_GITHUB_USERS: string
  ADMIN_EMAILS: string
  // Admission policy (plan L). 'open_domain' (default / unset) = legacy
  // env-allowlist behaviour; 'request' = domain match lands pending;
  // 'invite' = invite/join-code only. Parsed via parseAccessPolicy().
  ACCESS_POLICY?: string
  // Cloudflare Access (Zero Trust) trust mode. When the app is deployed behind
  // Cloudflare Access, set BOTH of these to accept the edge-asserted identity
  // (the Cf-Access-Jwt-Assertion header) as a sign-in source — see
  // auth/cf-access.ts. Neither is a secret; both are injected as [vars] by the
  // deploy. Unset ⇒ Access trust is off and only the IdP/cookie path runs.
  CF_ACCESS_TEAM_DOMAIN?: string // e.g. 'myteam.cloudflareaccess.com'
  CF_ACCESS_AUD?: string // the Access application's AUD tag
  // Build provenance, injected by the `deploy` script via `--var`.
  // Empty in local dev / a bare `wrangler deploy`.
  GIT_SHA: string
  BUILT_AT: string

  // Secrets (.dev.vars locally, `wrangler secret put` in deploys)
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
  GITHUB_CLIENT_ID: string
  GITHUB_CLIENT_SECRET: string
  ENCRYPTION_KEY: string
  SESSION_COOKIE_SECRET: string
  // Optional operator-alert webhook (Slack/Discord/generic incoming webhook).
  // When set, `ops/alert.ts notify()` POSTs cron/queue/poison failures here so
  // they're not buried in pull-only logs. Unset ⇒ alerting is a no-op.
  ALERT_WEBHOOK_URL?: string

  // Resource bindings
  DB: D1Database
  OAUTH_KV: KVNamespace
  DOCS_BUCKET: R2Bucket
  DOCS_INDEX: VectorizeIndex
  // Optional second Vectorize index holding the lexical (hashing-trick)
  // vectors for hybrid keyword recall (rag/lexical-embed.ts). Optional so
  // the code guards on its presence and degrades to dense-only when the
  // index/binding isn't provisioned yet.
  DOCS_LEXICAL_INDEX?: VectorizeIndex
  AI: Ai
  USAGE_QUEUE: Queue
  DOC_REINDEX_QUEUE: Queue
  GIT_SYNC_QUEUE: Queue
  MCP_SESSION_DO: DurableObjectNamespace
  DOC_ROOM_DO: DurableObjectNamespace
  ASSETS: Fetcher

  // Injected at runtime by @cloudflare/workers-oauth-provider so the
  // defaultHandler can parse authorize requests, look up clients, and
  // complete grants via `env.OAUTH_PROVIDER.completeAuthorization(...)`.
  OAUTH_PROVIDER: OAuthHelpers
}

/**
 * Token-derived properties attached to each authenticated MCP request.
 * Set by `provider.completeAuthorization({props})` in the IdP callback;
 * read by the McpAgent via `ctx.props` per request.
 */
export interface McpProps extends Record<string, unknown> {
  userId: string
  email: string
  role: 'user' | 'admin'
}

export type QueueName = 'ctxlayer-usage' | 'ctxlayer-reindex' | 'ctxlayer-git-sync'
