import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider'

/**
 * Typed wrangler bindings. Anything reachable through `env` in a Worker
 * handler is declared here. Never read `process.env` — Workers don't have it.
 */
export interface Env {
  // Static vars (wrangler.toml [vars])
  PUBLIC_BASE_URL: string
  ALLOWED_GOOGLE_HD: string
  ALLOWED_GOOGLE_EMAILS: string
  ALLOWED_GITHUB_ORG: string
  ALLOWED_GITHUB_USERS: string
  ADMIN_EMAILS: string
  DAYTONA_API_URL: string
  DAYTONA_DEFAULT_IDLE_SECONDS: string
  MAX_SANDBOXES_PER_USER: string

  // Secrets (.dev.vars locally, `wrangler secret put` in deploys)
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
  GITHUB_CLIENT_ID: string
  GITHUB_CLIENT_SECRET: string
  ENCRYPTION_KEY: string
  SESSION_COOKIE_SECRET: string
  DAYTONA_API_KEY: string
  SENTRY_DSN_WORKER?: string

  // Resource bindings
  DB: D1Database
  OAUTH_KV: KVNamespace
  DOCS_BUCKET: R2Bucket
  DOCS_INDEX: VectorizeIndex
  AI: Ai
  USAGE_QUEUE: Queue
  DOC_REINDEX_QUEUE: Queue
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

export type QueueName = 'ctxlayer-usage' | 'ctxlayer-reindex'
