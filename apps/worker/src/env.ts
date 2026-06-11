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
  // Admission policy (plan L). 'open_domain' (default / unset) = legacy
  // env-allowlist behaviour; 'request' = domain match lands pending;
  // 'invite' = invite/join-code only. Parsed via parseAccessPolicy().
  ACCESS_POLICY?: string
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
  SENTRY_DSN_WORKER?: string

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
