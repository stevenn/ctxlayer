# ctxlayer — Agent Context Layer (MCP Service on Cloudflare)

## Context

Building **ctxlayer**, a remote MCP server that:

1. Serves a curated library of internal docs/specs (markdown, with RAG search via Vectorize) so every AI agent in the org sees the same baseline context.
2. Acts as an OAuth-fronted **proxy** to other MCP servers in the org (Notion, Linear, internal APIs, ...), centralising credential storage so users only authenticate once.
3. Provides a self-onboarding SPA where users sign in (Google Workspace or GitHub), connect upstream services, and collaboratively edit the curated docs in a visual markdown editor (BlockNote + Yjs).
4. Provides an admin UI for upstream configuration, user management, and per-user usage analytics (tool calls, bytes, approximate tokens via tiktoken).

The repo is currently empty (only `README.md` + initial commit). This is greenfield.

**Locked-in choices** (from clarifying questions):
- Single-org per deployment (no multi-tenant complexity).
- Identity: **Google Workspace + GitHub** with org/domain allowlist.
- Upstream transports: **Streamable HTTP / SSE natively** on Workers, **stdio via Daytona Cloud** (a hosted container sandbox per user×upstream, with a stdio↔HTTP bridge inside).
- **Vectorize-backed RAG** for curated docs (chunked + embedded via Workers AI `@cf/baai/bge-base-en-v1.5`).
- Usage tracking: bytes + **approximate tokens via tiktoken** (WASM in the queue consumer).
- Editor: **BlockNote** (Notion-style, Tiptap-based, Yjs collab built in).
- Single Worker hosts both the API/MCP endpoints and the React SPA (Workers Assets).

**Why Daytona for stdio**: Workers cannot spawn subprocesses (no `child_process` even with `nodejs_compat` — `workerd` is a V8-isolate sandbox without POSIX). Stdio MCP servers need a real OS. Daytona offers sub-90ms sandbox creation, a TypeScript SDK callable from a Worker, public HTTP/WS proxy URLs (`{port}-{sandboxId}.proxy.daytona.app`) with API-key auth at the proxy, snapshot templates so the server is pre-installed, and auto-stop/activity-refresh lifecycle. ctxlayer's Worker stays the single source of truth; Daytona is a per-user execution backplane for stdio only.

**Inspiration**: [stainless-api/mcp-front](https://github.com/stainless-api/mcp-front). Reuse patterns (per-service auth strategies, encrypted creds at rest, audience-scoped tokens, OAuth gateway). Do not reuse code (Go, ELv2-licensed).

## Architecture overview

```
                +-----------------------------------------------------+
                |           Cloudflare edge (single Worker)           |
                |                                                     |
  MCP client -->|  /mcp, /sse  -> OAuthProvider -> McpSessionDO       |
  (Claude,      |                                  - props {user,role}|
   Cursor)      |                                  - tool registry    |
                |                                  - upstream Clients |
                |                                                     |
  Browser   --->|  / + /app/*  -> Workers Assets (React SPA)          |
                |  /api/*      -> Hono REST                           |
                |  /collab/:id -> DocRoomDO (Yjs + WS hibernation)    |
                |  /oauth/*    -> workers-oauth-provider              |
                |  /idp/google,                                        |
                |  /idp/github -> IdP callback handlers (allowlist)   |
                |                                                     |
                |  Queue consumers: usage -> D1, reindex -> Vectorize |
                +-----------------------------------------------------+
                     |        |        |        |          |       |
                     v        v        v        v          v       v
                    D1       KV       R2    Vectorize   Workers AI |
                                                                   |
                                              +--------------------+
                                              |                    |
                                              v                    v
                                       Daytona Cloud         Native HTTP/SSE
                                       (per-user sandbox     upstream MCP
                                        running stdio MCP    servers
                                        + stdio<->HTTP       (Notion, Linear,
                                        bridge)              internal)
```

### Key flows
- **MCP tool call (HTTP/SSE upstream)**: agent → `/mcp` → OAuth-validated → `McpSessionDO` resolves namespace `notion__create_page` → lazy-connects `UpstreamClient` with decrypted user credentials → streams response → `waitUntil` enqueues a usage event.
- **MCP tool call (stdio upstream via Daytona)**: agent → `/mcp` → `McpSessionDO` resolves namespace `github_stdio__create_issue` → calls `daytona.getOrCreateSandbox(userId, upstreamId)` (cold-creates from a pre-baked snapshot in <1s, or wakes existing) → sandbox start command runs the stdio MCP server behind a stdio↔HTTP bridge (e.g. `supergateway`) → `UpstreamClient` opens Streamable HTTP to `https://8080-{sandboxId}.proxy.daytona.app/mcp` with credentials in env vars → streams response → activity-refresh resets idle timer.
- **Doc edit**: SPA opens WebSocket to `/collab/:id` → `DocRoomDO` (one per doc) loads Y.Doc from R2 → BlockNote↔Yjs sync → debounced (5s idle / 30s max) snapshot to R2 + revision row in D1 + enqueue reindex.
- **Reindex**: queue consumer renders Y.Doc → markdown, chunks (~512 tokens, 64 overlap, heading-aware), embeds via Workers AI, upserts into Vectorize keyed `${docId}:${chunkIdx}`.

## Directory layout

Bun workspace, single deployable Worker, SPA shipped via Workers Assets.

```
ctxlayer/
  wrangler.toml
  package.json  bunfig.toml  tsconfig.base.json
  apps/
    worker/
      src/
        index.ts                # Hono app, mounts OAuthProvider + routes
        env.ts                  # Env binding types
        oauth/{provider,idp-google,idp-github,consent}.ts
        mcp/{session-do,tools-self,tools-proxy,upstream-client,tool-namespace}.ts
        upstream/{daytona,sandbox-pool}.ts        # Daytona SDK wrapper + lifecycle
        api/{docs,upstreams,users,usage,me}.ts
        collab/{doc-room-do,yjs-persistence}.ts
        queues/{usage-consumer,reindex-consumer}.ts
        crypto/aead.ts          # AES-GCM via WebCrypto
        rag/{chunker,embedder,index}.ts
        db/{client,migrations/*.sql,queries/*}.ts
        util/{bytes,tokens,allowlist}.ts
    web/                        # React + Vite, built to ../worker/public
      src/
        routes/{sign-in,docs/*,upstreams,mcp-setup,usage,admin/*}.tsx
        lib/{api,auth,yjs}.ts
        components/{editor,charts}/
  packages/
    shared/src/{api-types,mcp-types,upstream-auth-strategy}.ts
```

## Data model (D1)

The tables below cover the core MCP / docs / usage surfaces. The
**org information architecture** (teams, products, upstream visibility,
doc tags) is additive and lives in migration `0004_org_ia.sql` — see
**Section F** for the schema and access-resolution semantics.

```sql
-- 0001_init.sql
CREATE TABLE users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT, avatar_url TEXT,
  idp TEXT NOT NULL, idp_sub TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',          -- 'user' | 'admin'
  created_at INTEGER NOT NULL, last_seen_at INTEGER,
  UNIQUE(idp, idp_sub)
);

CREATE TABLE upstream_servers (
  id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE,  -- used in tool namespace
  display_name TEXT NOT NULL,
  transport TEXT NOT NULL,                    -- 'streamable_http' | 'sse' | 'stdio_daytona'
  url TEXT,                                   -- NULL for stdio_daytona (resolved from sandbox)
  auth_strategy TEXT NOT NULL,                -- 'none'|'shared_bearer'|'user_bearer'|'user_oauth'
  auth_config TEXT NOT NULL,                  -- JSON; see below
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
-- auth_config for stdio_daytona additionally carries:
--   { snapshotId, startCommand, bridgePort,
--     envTemplate: { "GITHUB_TOKEN": "${creds.access_token}", ... },
--     idleTimeoutSeconds, perUser: true }

-- Tracks live + archived sandboxes per (user, upstream); referenced for keep-alive,
-- admin listing, and destroy operations.
CREATE TABLE sandbox_sessions (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  upstream_id TEXT NOT NULL REFERENCES upstream_servers(id) ON DELETE CASCADE,
  sandbox_id TEXT NOT NULL,
  state TEXT NOT NULL,                        -- 'starting'|'running'|'idle'|'archived'|'destroyed'
  last_active_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, upstream_id)
);

CREATE TABLE upstream_tools (                  -- cached catalogue
  upstream_id TEXT NOT NULL REFERENCES upstream_servers(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL, description TEXT, input_schema TEXT NOT NULL,
  cached_at INTEGER NOT NULL,
  PRIMARY KEY (upstream_id, tool_name)
);

CREATE TABLE user_credentials (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  upstream_id TEXT NOT NULL REFERENCES upstream_servers(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                         -- 'bearer' | 'oauth'
  ciphertext BLOB NOT NULL, iv BLOB NOT NULL, key_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, upstream_id)
);

-- 0002_docs.sql
CREATE TABLE documents (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'doc',           -- 'doc' | 'prompt'
  current_rev_id TEXT, r2_snapshot TEXT,
  created_by TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE TABLE doc_revisions (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  author_id TEXT REFERENCES users(id),
  r2_key TEXT NOT NULL, byte_size INTEGER NOT NULL, content_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- 0003_usage.sql
CREATE TABLE usage_events (
  id TEXT PRIMARY KEY, ts INTEGER NOT NULL,
  user_id TEXT NOT NULL, session_id TEXT NOT NULL,
  upstream_id TEXT, tool TEXT NOT NULL,       -- upstream_id NULL = built-in
  req_bytes INTEGER NOT NULL, resp_bytes INTEGER NOT NULL,
  req_tokens INTEGER NOT NULL, resp_tokens INTEGER NOT NULL,  -- via tiktoken
  latency_ms INTEGER NOT NULL, status TEXT NOT NULL
);
CREATE INDEX idx_usage_user_ts ON usage_events(user_id, ts DESC);

CREATE TABLE usage_rollups_daily (
  day INTEGER NOT NULL, user_id TEXT NOT NULL,
  upstream_id TEXT, tool TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  req_bytes INTEGER NOT NULL DEFAULT 0, resp_bytes INTEGER NOT NULL DEFAULT 0,
  req_tokens INTEGER NOT NULL DEFAULT 0, resp_tokens INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, user_id, COALESCE(upstream_id,''), tool)
);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY, ts INTEGER NOT NULL,
  actor_id TEXT, action TEXT NOT NULL, target TEXT, meta TEXT
);
```

OAuth provider state (inbound clients/tokens) is fully managed by `workers-oauth-provider` in KV — no D1 mirror needed unless the admin UI wants to read it directly.

## Auth model

### Inbound (MCP client → ctxlayer) — `@cloudflare/workers-oauth-provider`
- Implements OAuth 2.1 + PKCE + RFC 7591 dynamic client registration + RFC 8707 audience-scoped tokens.
- Sign-in leg shows chooser → redirects to Google or GitHub → callback completes the issued token with `props = {userId, email, name, role}`.
- Allowlist enforced in callback:
  - Google: ID token `hd` claim must equal `ALLOWED_GOOGLE_HD`.
  - GitHub: `GET /user/orgs` must include `ALLOWED_GITHUB_ORG`.
- `props` ride with the access token through to `McpSessionDO`, where `this.props.userId` identifies the calling user across the session.

### Outbound (ctxlayer → upstream MCP) — strategies per upstream
- `none` — no header.
- `shared_bearer` — admin-supplied key (encrypted in `auth_config`), used for all users.
- `user_bearer` — user pastes a PAT in the SPA; encrypted in `user_credentials`; injected per request.
- `user_oauth` — ctxlayer is an OAuth client to upstream. The SPA "Connect" button drives `/api/upstreams/:id/oauth/start` → upstream → `/oauth/callback`; `{access_token, refresh_token, expires_at}` stored encrypted; `UpstreamClient.ensureFreshToken()` refreshes on demand.

### Encryption at rest
- `ENCRYPTION_KEY` secret (32 random bytes b64) imported as non-extractable `CryptoKey`.
- `apps/worker/src/crypto/aead.ts` exposes `seal(plain) → {ciphertext, iv}` and `open(...)`.
- `key_version` column reserved for future rotation.

### Admin gating
- `users.role`. Bootstrap via `ADMIN_EMAILS` env var (auto-promote on sign-in). Admins promote others through UI (audit-logged).
- Every `/api/admin/*` route checks `props.role === 'admin'` server-side.

## MCP server surface

### Built-in tools
- `search_docs({ query, k?, scope? })` — Vectorize query over chunked curated docs. `scope` defaults to the caller's teams/products (see Section F3); pass `'all'` to disable filtering.
- `get_doc({ id })` — returns rendered markdown from R2 (cached `docs/{id}/markdown.md`).
- `list_upstreams()` — `[{slug, displayName, connected}]` for the calling user. Already scoped by `upstream_visibility` (Section F2).
- `list_my_context()` — `{teams, products, accessibleUpstreams, defaultScope}` for agent self-orientation (Section F4).

### Dynamic proxied tools
- For each enabled upstream where the caller has access via `upstream_visibility` (Section F2) AND is credentialed (or strategy is `none`/`shared_bearer`), the cached `upstream_tools` rows are exposed with `name = ${slug}__${upstreamToolName}` and the original schema. Description is prefixed with `[${displayName}]`. `__` in original tool names is escaped to `_~_`.

### Resources & prompts
- Each non-deleted document is published as `mcp://ctxlayer/docs/{id}` (`text/markdown`).
- `documents` with `kind = 'prompt'` are exposed via `prompts/list`; arguments declared in YAML frontmatter with `{{name}}` placeholders.

## Upstream proxy mechanics

- **Lazy connect**: `McpSessionDO` holds `Map<upstreamId, UpstreamClient>`, empty on session start. First matching `tools/call` triggers connect; built-ins never force a connect.
- For `streamable_http` / `sse`: `@modelcontextprotocol/sdk`'s `Client` + the matching transport. Headers built per request so credential refresh doesn't require reconnect.
- For `stdio_daytona`: before constructing the transport, call `daytona.getOrReadySandbox({userId, upstreamId, snapshotId, startCommand, env})`. Returns `{sandboxId, baseUrl}`; `baseUrl` becomes the Streamable HTTP endpoint. The credentials are injected as **environment variables** at sandbox start (substituted from `envTemplate`), not as HTTP headers — that's how stdio MCP servers conventionally consume them. The bridge inside the sandbox (`supergateway` or `mcp-proxy`) exposes the stdio process as Streamable HTTP, so the rest of the proxy code is identical.
- **Sandbox keep-alive**: on every successful tool call to a stdio upstream, fire-and-forget `daytona.refreshActivity(sandboxId)` via `ctx.waitUntil` so the auto-stop timer resets.
- **Sandbox lifecycle**: configurable `idleTimeoutSeconds` (default 600). When Daytona auto-stops, `sandbox_sessions.state` is reconciled by the nightly cron (which lists Daytona sandboxes and updates rows). Admin UI can force-destroy.
- **Tool catalogue refresh**: on first connect per session, call `client.listTools()` and overwrite `upstream_tools` rows. Nightly cron also refreshes all enabled upstreams (for stdio upstreams the cron wakes a shared "catalogue" sandbox, lists, then stops — keeps user sandboxes uncreated).
- **Errors**: upstream JSON-RPC errors pass through; transport errors become `{code: -32603, message: "Upstream {slug} unavailable: ..."}`. Tool errors come back with `isError: true` so agents can recover. Sandbox-specific failures (out of quota, snapshot not found, sandbox crashed) surface a distinct user-readable message.
- **Streaming**: responses piped through; no buffering. Hard 60s wall-clock cap per upstream call.

## Collaborative editor

- **SPA**: `@blocknote/react` + `@blocknote/core` with the Yjs collab extension.
- **Transport**: WebSocket to `/collab/:id`, session cookie + CSRF token verified before `upgrade`.
- **`DocRoomDO`** (one per doc):
  - WebSocket Hibernation API (`webSocketMessage`, `webSocketClose`).
  - Lazy-loads `docs/{id}/snapshot.bin` from R2 on first wake.
  - Broadcasts sync/awareness frames via `ctx.getWebSockets()`.
  - Debounced flush (5s idle / 30s max) + final flush via `setAlarm` when room empties.
  - Flush writes snapshot to R2, rotates `revisions/{ts}.bin`, inserts `doc_revisions` row, enqueues `{docId, revisionId}` to `DOC_REINDEX_QUEUE`.
- **Reindex consumer** uses `@blocknote/server-util` to convert Y.Doc → markdown, chunks (~512 tokens, 64 overlap, heading-aware), embeds via Workers AI `@cf/baai/bge-base-en-v1.5` (768-dim), deletes old vectors for the doc, upserts new.

## Usage tracking

- `McpSessionDO` wraps its JSON-RPC dispatch with an `onRequest`/`onResponse` middleware that records `tools/call`, `resources/read`, `prompts/get`. List operations are not metered.
- Each event → `env.USAGE_QUEUE.send(...)` via `ctx.waitUntil` (non-blocking).
- **Queue consumer** (`usage-consumer.ts`):
  1. Batches up to 100 events.
  2. Tokenizes `req` and `resp` JSON via `js-tiktoken` (cl100k_base encoding, loaded once per isolate). Populates `req_tokens`/`resp_tokens`.
  3. Inserts raw rows + upserts daily rollups with `+=` deltas.
- Documented as **approximate tokens** — model isn't ours; counts are heuristic for the prompt assembly the agent does on top of these payloads.
- Retention: `usage_events` 30 days (nightly cron prune); `usage_rollups_daily` retained indefinitely.

## Admin UI (`/app/admin/*`, role-gated)

- **Upstreams**: CRUD list + edit modal (slug, display name, transport, URL, auth-strategy conditional fields). "Test connection" + "Refresh tool cache" buttons. Visibility section per Section F5.
- **Users**: email/IdP/role/last-seen/30d-calls table; promote/demote; revoke all creds. Inline team-membership editor.
- **Teams / Products / Team↔Product matrix**: see Section F5.
- **Usage**: line chart calls/day, stacked bar by upstream, top tools/users tables, date+upstream+user filters. Data from `usage_rollups_daily`.
- **Docs library**: same editor, with delete/rename/revision-history + tag editor pane (Section F5).
- **OAuth clients**: lists DCR-registered MCP clients (reads `OAUTH_KV`), revoke purges tokens.
- **Audit log**: tail of `audit_log` rows.

## User UI

- `/sign-in` — Google + GitHub buttons.
- `/upstreams` — cards per enabled upstream with the right control for its auth strategy (paste-PAT, "Connect" OAuth popup, or admin-managed read-only). **Crucial UX note**: all `user_oauth` connections happen here in the SPA, *before* the agent session, so Claude/Cursor never need to host a browser flow.
- `/mcp-setup` — shows the ctxlayer MCP URL + a generated bearer token (preferred: instructions for DCR so the client registers itself).
- `/docs` — tree/list + BlockNote+Yjs editor over `/collab/:id`.
- `/usage` — personal stats (today/week/month, by upstream, by tool).

## Deployment / configuration

`wrangler.toml` essentials:

```toml
name = "ctxlayer"
main = "apps/worker/src/index.ts"
compatibility_date = "2026-05-01"
compatibility_flags = ["nodejs_compat"]

[assets]
directory = "apps/web/dist"
binding = "ASSETS"
run_worker_first = ["/api/*", "/mcp/*", "/sse/*", "/oauth/*", "/idp/*", "/collab/*"]

[[d1_databases]]    binding = "DB"            database_name = "ctxlayer"
[[kv_namespaces]]   binding = "OAUTH_KV"
[[r2_buckets]]      binding = "DOCS_BUCKET"   bucket_name = "ctxlayer-docs"
[[vectorize]]       binding = "DOCS_INDEX"    index_name = "ctxlayer-docs"
[ai]                binding = "AI"

[[durable_objects.bindings]] name = "MCP_SESSION_DO" class_name = "McpSessionDO"
[[durable_objects.bindings]] name = "DOC_ROOM_DO"    class_name = "DocRoomDO"

[[queues.producers]] binding = "USAGE_QUEUE"        queue = "ctxlayer-usage"
[[queues.producers]] binding = "DOC_REINDEX_QUEUE"  queue = "ctxlayer-reindex"
[[queues.consumers]] queue = "ctxlayer-usage"       max_batch_size = 100
[[queues.consumers]] queue = "ctxlayer-reindex"     max_batch_size = 10

[triggers] crons = ["0 3 * * *"]   # prune usage, refresh upstream tool cache

[vars]
ALLOWED_GOOGLE_HD = "acme.com"
ALLOWED_GITHUB_ORG = "acme-inc"
ADMIN_EMAILS = "stevenn@satisa.be"
PUBLIC_BASE_URL = "https://ctx.acme.com"
```

Secrets (`wrangler secret put`): `ENCRYPTION_KEY`, `GOOGLE_CLIENT_ID/SECRET`, `GITHUB_CLIENT_ID/SECRET`, `SESSION_COOKIE_SECRET`, `DAYTONA_API_KEY`.

Vars: `DAYTONA_API_URL` (default Daytona Cloud endpoint), `DAYTONA_DEFAULT_IDLE_SECONDS`, `MAX_SANDBOXES_PER_USER` (quota).

## Milestone breakdown (~9.5 weeks for one engineer)

Each milestone is independently deployable and demoable.

- **M1 — Skeleton (1 wk)**: Bun workspace, Vite SPA shell, `wrangler.toml` with all bindings, D1 migrations 0001–0004, Google/GitHub sign-in with allowlist, `/api/me`, `/api/config`. *Demo*: sign in, see your email. **Status: complete. Scaffold + sign-in leg landed; local HTTPS via mkcert (see Section G11).**
- **M2 — Docs + RAG (1.5 wk)**: BlockNote editor with REST save (no collab yet), R2 storage, `documents`/`doc_revisions`, reindex queue + Vectorize + Workers AI, `McpAgent` mounted at `/mcp`+`/sse`, `workers-oauth-provider` wired, built-in tools `search_docs`/`get_doc`, doc resources. *Demo*: Claude Desktop searches internal docs via MCP.
- **M3 — Realtime collab (1 wk)**: `DocRoomDO` with Yjs + WS hibernation, BlockNote switched from REST to Yjs over `/collab/:id`, snapshot/revision/reindex chain. *Demo*: two browser tabs edit live; MCP search reflects changes within seconds.
- **M4 — Upstream proxy: bearer + stdio via Daytona (3 wk)**: `upstream_servers` + `sandbox_sessions` admin REST (no UI yet), `user_credentials` + AES-GCM crypto, `UpstreamClient` lazy connect + catalogue cache, dynamic tool aggregation + proxy routing, `apps/worker/src/upstream/daytona.ts` wrapping `@daytonaio/sdk` (`getOrReadySandbox`, `refreshActivity`, `destroy`), one pre-baked Daytona snapshot for a reference stdio MCP server (e.g. `@modelcontextprotocol/server-github` + `supergateway`), env-var template substitution from `user_credentials`, SPA `/upstreams` for `user_bearer` strategy (works for both HTTP and stdio_daytona transports). *Demo*: (a) Notion HTTP MCP added, user pastes token, agent calls `notion__search_pages`; (b) GitHub stdio MCP added (Daytona snapshot), user pastes PAT, agent calls `github_stdio__create_issue`; sandbox auto-stops after 10min idle.
- **M5 — OAuth upstreams + Admin UI (2 wk)**: `user_oauth` start/callback/refresh, admin UI (upstreams CRUD including snapshot/start-command editor for stdio_daytona, users, oauth-clients, audit log, **sandboxes view** showing live/idle/archived sandboxes per user with force-destroy), role promotion. *Demo*: Linear added via OAuth; admin manages everything from UI including killing a runaway sandbox.
- **M6 — Usage pipeline + dashboards (1 wk)**: usage queue + tiktoken consumer + rollups, admin usage dashboard, user usage page, cron prune. *Demo*: charts showing per-user/per-upstream calls + tokens.

## Patterns to mirror from mcp-front (and what to skip)

**Reuse (patterns only — Go code is not reused):**
- Per-upstream `auth_strategy` field driving per-user vs shared credential handling.
- AES-GCM-at-rest for user credentials.
- Two-sided OAuth gateway (issuer to MCP clients, client to upstreams).
- RFC 8707 audience-scoped tokens (built into `workers-oauth-provider`).
- Org allowlist via IdP claims (Google `hd`, GitHub org membership).
- `slug__tool` namespacing across upstreams.

**Diverge:**
- Stdio transport — mcp-front spawns subprocesses directly; ctxlayer offloads to Daytona Cloud sandboxes per (user, upstream) with an in-sandbox stdio↔HTTP bridge.
- mcp-front's Go runtime and ELv2 licensing — pick our own license freely.

## Risks / known unknowns

- **Daytona cost scaling**: per-user × per-stdio-upstream active sandboxes. 100 users × 3 stdio upstreams ≈ up to 300 concurrent sandboxes at peak. Mitigations: aggressive `idleTimeoutSeconds`, `MAX_SANDBOXES_PER_USER` quota enforced at provision time, admin UI showing live sandbox count + cost-per-day projection. Re-evaluate at M6 with real usage data.
- **Daytona vendor lock-in**: `apps/worker/src/upstream/daytona.ts` is a single file; keep the interface narrow (`getOrReadySandbox`, `refreshActivity`, `destroy`, `list`) so swapping to E2B / Northflank / self-hosted Daytona later is a one-file change.
- **Daytona availability dependence**: if Daytona Cloud is down, stdio upstreams are down. HTTP upstreams remain unaffected. Surface this in the admin UI status panel and add a circuit breaker that fast-fails stdio tool calls after N consecutive sandbox-create failures.
- **Sandbox snapshot drift**: stdio MCP servers update frequently; snapshots go stale. Build a `bun run rebuild-snapshot:<slug>` script that rebuilds + uploads new snapshots, and surface the snapshot's pinned package version in the admin UI.
- **Credential exposure inside the sandbox**: tokens flow as env vars into the container. Anyone with sandbox shell access (via Daytona's exec API or web preview) could `printenv` them. Mitigations: disable interactive shells on production snapshots, restrict `DAYTONA_API_KEY` scope to "execute + lifecycle, no exec/preview", per-user sandboxes so a leak is bounded to that user's creds.
- **MCP spec churn**: pin `@modelcontextprotocol/sdk` and `agents`; support both Streamable HTTP and SSE today; revisit when SSE fully deprecates.
- **OAuth UX from inside the agent**: handled by doing all `user_oauth` connection in the SPA before the agent session — flag this prominently in `/mcp-setup`.
- **Vectorize cost/limits**: 5M vectors/index is plenty for org-scale corpora; cache `search_docs` results in KV by query hash if it becomes hot.
- **Workers CPU/wall limits**: streaming responses avoid CPU pressure; enforce 60s wall cap on a single upstream call.
- **D1 write QPS** on `usage_events`: queue batching is the safety valve; shardable by user-id prefix later if needed.
- **Workers Assets vs API route shadowing**: be explicit with `run_worker_first` patterns.

## Verification plan

After each milestone:
- **M1**: `wrangler deploy`, open URL, sign in with both Google and GitHub, confirm allowlist rejection works for outside-domain users.
- **M2**: Add ctxlayer to Claude Desktop as remote MCP server; run `search_docs` and `get_doc`; verify reindex queue depth via `wrangler queues consumer`.
- **M3**: Two browser tabs editing concurrently; kill DO via `wrangler tail`, confirm WS reconnect + snapshot reload; verify revisions in D1.
- **M4**: (a) Add Notion HTTP upstream via D1 insert; paste PAT in SPA; from Claude call `notion__search_pages`; verify decrypted creds never leave the Worker (check logs). (b) Pre-build a Daytona snapshot containing `@modelcontextprotocol/server-github` + `supergateway`; register as `stdio_daytona` upstream; from Claude call `github_stdio__create_issue`; observe sandbox in Daytona dashboard; wait 10min; confirm auto-stop; call again, confirm wake works.
- **M5**: Walk OAuth flow end-to-end for Linear; force token expiry by editing `expires_at`, confirm auto-refresh; admin UI smoke-test all CRUD operations.
- **M6**: Drive synthetic load (script that opens MCP session + calls 100 tools), confirm `usage_events` populated and `usage_rollups_daily` reflects totals; verify tiktoken counts ≈ `OpenAI` tokenizer for spot-checked payloads.

## Critical files (created from scratch)

- `wrangler.toml`
- `apps/worker/src/index.ts` — entry, mounts OAuthProvider + Hono routes + Assets
- `apps/worker/src/mcp/session-do.ts` — `McpSessionDO` extends `McpAgent`
- `apps/worker/src/mcp/tools-proxy.ts` — dynamic tool aggregation + routing
- `apps/worker/src/mcp/upstream-client.ts` — wraps `@modelcontextprotocol/sdk` Client with credential injection + refresh
- `apps/worker/src/upstream/daytona.ts` — Daytona SDK wrapper (`getOrReadySandbox`, `refreshActivity`, `destroy`, `list`)
- `infra/daytona-snapshots/` — Dockerfile templates per stdio MCP server (one per supported upstream), plus a `build-and-push.ts` script
- `apps/worker/src/collab/doc-room-do.ts` — Yjs over WS hibernation
- `apps/worker/src/queues/usage-consumer.ts` — tiktoken + rollups
- `apps/worker/src/queues/reindex-consumer.ts` — chunk + embed + Vectorize upsert
- `apps/worker/src/crypto/aead.ts` — AES-GCM wrapper
- `apps/worker/src/db/migrations/0001_init.sql`, `0002_docs.sql`, `0003_usage.sql`
- `apps/web/src/routes/docs/editor.tsx` — BlockNote + Yjs binding
- `apps/web/src/routes/upstreams.tsx` — connect wizard (PAT + OAuth popup)
- `apps/web/src/routes/admin/*.tsx` — admin pages
- `packages/shared/src/api-types.ts` — shared types between worker and SPA

---

# Plan Refinements — Deep Dives

## A. Auth flows (inbound + outbound)

ctxlayer is **two-sided**: an OAuth **issuer** to MCP clients and SPA users, and an OAuth **client** to upstream services. Each side has multiple sub-flows. Below are the full sequences.

### A1. Inbound — MCP client connects (DCR flow, preferred)

Used when the MCP client supports Dynamic Client Registration (Claude Desktop, Claude Web, Cursor, Windsurf, mcp-remote).

```
MCP client                      ctxlayer (Worker)                Google/GitHub
    |                                |                                |
    | 1. GET /.well-known/           |                                |
    |    oauth-authorization-server  |                                |
    |------------------------------->|                                |
    |<---- metadata (RFC 8414) ------|                                |
    | 2. POST /oauth/register (RFC 7591)                              |
    |    {redirect_uris, ...}        |                                |
    |------------------------------->|                                |
    |<---- {client_id, ...} ---------|                                |
    | 3. GET /oauth/authorize?response_type=code&code_challenge=...    |
    |------------------------------->|                                |
    |       (no session cookie)      | --shows IdP chooser SSR page-->|
    |<---- 200 chooser page ---------|                                |
    | 4. user clicks "Sign in with Google"                            |
    |    GET /idp/google/start?state=<authz_state>                    |
    |------------------------------->|                                |
    |                                | 302 to Google authorize        |
    |<---- 302 ----------------------|                                |
    | 5. Google login + consent      |                                |
    |------------------------------->|------------------------------->|
    |                                |<--- 302 /idp/google/callback   |
    | 6. /idp/google/callback?code=  |                                |
    |------------------------------->|                                |
    |                                | exchange code, verify id_token,|
    |                                | check hd == ALLOWED_GOOGLE_HD, |
    |                                | upsert user in D1,             |
    |                                | call provider.completeAuthor-  |
    |                                |   ization(props={userId,email, |
    |                                |   role,scopes})                |
    |<---- 302 redirect_uri+code ----|                                |
    | 7. POST /oauth/token?grant=    |                                |
    |    authorization_code+verifier |                                |
    |------------------------------->|                                |
    |<---- {access_token,            |                                |
    |       refresh_token,           |                                |
    |       aud: "https://.../mcp"}--|                                |
    | 8. POST /mcp (Authorization: Bearer <access_token>)             |
    |------------------------------->|                                |
    |                                | OAuthProvider middleware       |
    |                                | -> decodes token, attaches     |
    |                                |    props to ctx.executionCtx   |
    |                                | -> routes to McpSessionDO      |
    |                                |    (DO id derived from         |
    |                                |    Mcp-Session-Id header)      |
    |<---- JSON-RPC initialize ack --|                                |
```

Key implementation notes:
- `@cloudflare/workers-oauth-provider` exposes `provider.fetch(req, env, ctx)`. Mount it as the **outermost** handler in `index.ts`. It intercepts `/.well-known/oauth-authorization-server`, `/oauth/register`, `/oauth/authorize`, `/oauth/token`, `/oauth/revoke` automatically. Everything else falls through to `defaultHandler`.
- The IdP leg is **inside** `defaultHandler` because it's UI flow. After the IdP callback verifies + upserts the user, it calls `provider.completeAuthorization({ request, userId, metadata, scope, props })`. That issues the authorization code that the MCP client redeemed in step 7.
- `props` is **end-to-end encrypted** by the provider library before being stored against the token in KV. The encryption uses a key derived from `OAUTH_KV` so only the live Worker can decrypt — a KV dump alone does not leak `props`.
- The `aud` claim on the issued access token is set to `${PUBLIC_BASE_URL}/mcp` (RFC 8707). The Worker validates `aud` on every request — a token leaked from another aud is rejected.

### A2. Inbound — MCP client without DCR (paste-bearer fallback)

Some clients still don't speak DCR. Provide a fallback:
- The user signs into the SPA, navigates to `/app/mcp-setup`, clicks "Generate access token".
- Worker creates a long-lived OAuth client (DCR-equivalent) bound to this user with a fixed redirect, then issues a refresh-friendly access token using the same `props` payload.
- Page displays the token + the MCP server URL + a copy-pasteable JSON snippet for the user's `claude_desktop_config.json` / Cursor settings.
- These tokens are listed in admin "OAuth clients" UI and can be revoked.

### A3. Inbound — SPA session cookie (separate from MCP tokens)

The SPA needs its own session — it doesn't hold an MCP OAuth token; that's for MCP clients only.
- The same `/idp/google/start` and `/idp/github/start` endpoints accept a query flag `?ui=1` indicating SPA login.
- After the IdP callback succeeds, instead of calling `provider.completeAuthorization`, the handler sets a `__Host-ctx_session` cookie:
  - `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, `Max-Age=30d`.
  - Body is `{ userId, role, exp }` signed with `SESSION_COOKIE_SECRET` (HMAC-SHA256) — cheap to verify on every `/api/*` call.
- A second cookie `__Host-ctx_csrf` holds a random token; the SPA echoes it in `X-CSRF` for unsafe methods.
- Sign-out: `/api/auth/signout` clears both cookies. Doesn't affect MCP tokens (separate lifecycles).

### A4. Allowlist enforcement (centralised)

Single helper `util/allowlist.ts`:
```ts
async function enforceAllowlist(idp, profile, env): Promise<void> {
  if (idp === 'google') {
    if (!env.ALLOWED_GOOGLE_HD) throw forbidden('google_disabled')
    if (profile.hd !== env.ALLOWED_GOOGLE_HD) throw forbidden('wrong_domain')
  } else if (idp === 'github') {
    if (!env.ALLOWED_GITHUB_ORG) throw forbidden('github_disabled')
    const orgs = await fetch('https://api.github.com/user/orgs', {
      headers: { Authorization: `Bearer ${profile.access_token}` }
    }).then(r => r.json() as Promise<{login: string}[]>)
    if (!orgs.some(o => o.login === env.ALLOWED_GITHUB_ORG)) throw forbidden('not_in_org')
  }
}
```
The thrown `forbidden(reason)` redirects to a `/sign-in?error=<reason>` page that explains the rejection without leaking config details.

### A5. Outbound — `user_bearer` flow

```
User in SPA           ctxlayer                 (no upstream interaction during setup)
   |                     |
   | POST /api/upstreams/:id/credentials
   | { kind:'bearer', token:'ghp_xxx' }
   |-------------------->|
   |                     | AES-GCM seal(token), insert user_credentials
   |<-- 204 -------------|

(later, during MCP session)
McpSessionDO           upstream
   |                     |
   | open creds row, AES-GCM open(ciphertext) -> {access_token}
   | Streamable HTTP POST {...} with Authorization: Bearer ghp_xxx
   |-------------------->|
   |<--- tool result ----|
```

### A6. Outbound — `user_oauth` flow

ctxlayer is a confidential OAuth client to the upstream. Upstream's client_id/secret are stored in `upstream_servers.auth_config` (the secret is encrypted with `ENCRYPTION_KEY`).

```
User in SPA              ctxlayer                          Upstream
   | click "Connect Linear" |                                  |
   | GET /api/upstreams/:id/oauth/start?return_to=/upstreams   |
   |------------------------>|                                  |
   |                         | generate state (signed cookie),  |
   |                         | PKCE verifier (KV TTL 10min),    |
   |                         | construct authorize URL          |
   |<-- 302 to upstream --- |                                  |
   | GET upstream/authorize? client_id=..&code_challenge=..&state=..
   |--------------------------------------------------------->|
   | user grants                                              |
   |<-- 302 ctxlayer/api/upstreams/:id/oauth/callback?code=---|
   |                         |                                  |
   | GET /callback?code=&state=                                 |
   |------------------------>|                                  |
   |                         | verify state cookie, fetch       |
   |                         | verifier from KV, POST token EP--|
   |                         |<-- {access_token, refresh_token, |
   |                         |     expires_in} -----------------|
   |                         | AES-GCM seal, upsert user_credentials kind='oauth'
   |<-- 302 return_to -------|

(later, on refresh)
UpstreamClient.ensureFreshToken():
  if now + 60s > expires_at:
    POST upstream/token grant_type=refresh_token refresh_token=...
    AES-GCM seal new pair, UPDATE user_credentials
    (with a per-user mutex via DO single-threaded execution to avoid double-refresh)
```

### A7. Outbound — `shared_bearer`

Admin pastes once in `/app/admin/upstreams` edit form. Stored in `upstream_servers.auth_config` encrypted. Injected unconditionally. No `user_credentials` row exists. Risk: every user appears as the same identity to upstream; rate limits shared.

### A8. Token & secret matrix

| What | Where | Lifetime | Encrypted? |
|---|---|---|---|
| Inbound MCP access token | `OAUTH_KV` (provider-managed) | 1h, refreshable | Yes (provider) |
| Inbound MCP refresh token | `OAUTH_KV` | rolling, max ~90d | Yes (provider) |
| SPA session cookie | client browser | 30d | HMAC-signed, not encrypted (no secrets in body) |
| User upstream `bearer` PAT | `user_credentials` | until user revokes | AES-GCM, `ENCRYPTION_KEY` |
| User upstream OAuth tokens | `user_credentials` | per upstream policy | AES-GCM, `ENCRYPTION_KEY` |
| Admin shared bearer | `upstream_servers.auth_config` | until admin rotates | AES-GCM, `ENCRYPTION_KEY` |
| Upstream OAuth client secret | `upstream_servers.auth_config` | until admin rotates | AES-GCM, `ENCRYPTION_KEY` |
| `ENCRYPTION_KEY`, IdP secrets, `DAYTONA_API_KEY` | wrangler secrets | rotated by ops | yes (CF secret) |

---

## B. Daytona stdio bridge — concrete recipe

### B1. Snapshot Dockerfile pattern

One Dockerfile per supported stdio MCP server. Base image is shared.

`infra/daytona-snapshots/base/Dockerfile`:
```dockerfile
FROM node:22-alpine
RUN apk add --no-cache python3 py3-pip dumb-init curl
RUN npm install -g supergateway@latest
EXPOSE 8080
ENTRYPOINT ["dumb-init", "--"]
# subclasses override CMD
```

`infra/daytona-snapshots/github-stdio/Dockerfile`:
```dockerfile
FROM ctxlayer/base:latest
RUN npm install -g @modelcontextprotocol/server-github@pinned-version
ENV BRIDGE_PORT=8080
# supergateway wraps the stdio process and exposes Streamable HTTP on 8080
CMD ["sh", "-c", "supergateway --stdio 'mcp-server-github' --port ${BRIDGE_PORT} --transport streamableHttp"]
```

Bridge choice rationale: **supergateway** is the canonical Node-based stdio↔HTTP MCP bridge. Picked over `mcp-proxy` (Python) because most stdio MCP servers are Node, base image is smaller, and we get one runtime instead of two. `mcp-proxy` remains an option for Python-only stdio servers (`mcp-server-fetch` etc.) via a separate base image.

### B2. Snapshot baking pipeline

`infra/daytona-snapshots/build-and-push.ts`:
1. For each subdirectory: `docker build`, tag with `${slug}:${gitsha}` and `${slug}:latest`.
2. Push to Daytona's registry (or a public registry referenced from Daytona).
3. Call Daytona's snapshot-create API to register the new image as a snapshot, returning a `snapshotId`.
4. Update `upstream_servers.auth_config.snapshotId` for that slug (admin opt-in to roll forward).
5. Output a small summary table: `slug | old snapshot | new snapshot | size | server version`.

CI workflow runs this nightly + on push to `infra/daytona-snapshots/**` so snapshots stay close to current.

### B3. Env-var substitution

`upstream_servers.auth_config.envTemplate` for the GitHub stdio example:
```json
{
  "GITHUB_TOKEN": "${creds.access_token}",
  "GITHUB_ENTERPRISE_URL": "${upstream.auth_config.enterprise_url}",
  "MCP_DEBUG": "false"
}
```

`apps/worker/src/upstream/daytona.ts` resolves each `${...}` against:
- `creds.*` — the decrypted user_credentials JSON (or shared_bearer auth_config).
- `upstream.*` — non-secret upstream config.
- `user.*` — sanitised user fields (email, idp_sub) for upstream servers that want a calling-user identity.

Resolved env is passed to Daytona's sandbox-create API as the container's environment. The Worker never logs the resolved env.

### B4. Sandbox lifecycle in detail

```
First tool call for stdio_daytona upstream
  -> McpSessionDO.callUpstream(upstreamId, ...)
     -> ensureSandbox(userId, upstreamId)
        SELECT * FROM sandbox_sessions WHERE user_id=? AND upstream_id=?
        if row exists AND state IN ('running','idle'):
          POST {daytona}/sandboxes/{id}/start  (no-op if already running)
        else:
          quota check: count(running) for user < MAX_SANDBOXES_PER_USER
          POST {daytona}/sandboxes {snapshotId, env, autoStopMinutes}
          INSERT/UPDATE sandbox_sessions row, state='starting'
        poll GET {daytona}/sandboxes/{id} until state=='running' (timeout 5s, sub-90ms typical)
        UPDATE sandbox_sessions SET state='running', last_active_at=now
        return baseUrl = `https://${BRIDGE_PORT}-${sandboxId}.proxy.daytona.app`

  -> open Streamable HTTP Client to baseUrl, attach Daytona proxy auth header
  -> proxy the JSON-RPC call
  -> ctx.waitUntil(daytona.refreshActivity(sandboxId))
  -> ctx.waitUntil(USAGE_QUEUE.send({...}))
```

Concurrency: McpSessionDO is single-threaded per session (it IS a DO), so two parallel tool calls inside one session serialise through the same `ensureSandbox`. Across sessions for the same user we use a D1 row-level lock (`UPDATE ... WHERE state='starting'` returning row count) to dedupe creates.

### B5. Keep-alive vs. Workers wall-clock

- Each tool call invokes `refreshActivity` via `waitUntil`. That keeps the Daytona auto-stop timer at the configured `idleTimeoutSeconds` (default 600s).
- Workers wall-clock doesn't constrain *the sandbox*; it constrains how long the Worker handles a single MCP request. The sandbox keeps running between requests.
- For a session where the agent goes silent for >`idleTimeoutSeconds`, Daytona auto-stops. The next tool call wakes it (start, not create) — typically faster than cold create. The Worker handles this transparently.

### B6. Per-user vs. pooled — locked decision

- **Per-user** sandboxes. Reason: stdio MCP servers cache auth state (cookies, local sqlite, oauth tokens). A pooled sandbox would either need per-call state injection (most servers don't support it) or would leak state across users. Per-user is safer and matches mcp-front's model.
- Exception: a single shared "catalogue" sandbox is started briefly by cron to call `tools/list` and refresh the cached catalogue. No user creds are loaded into it. It auto-stops minutes after the cron tick.

### B7. Fallback when Daytona is unhealthy

Circuit breaker in `apps/worker/src/upstream/daytona.ts`:
- Per-upstream sliding-window counter in DO storage of the `McpSessionDO`. >3 consecutive failures within 60s → open circuit for 30s. While open, `tools/call` on that upstream returns `{ isError: true, content: [{type:'text', text:'Stdio upstream temporarily unavailable.'}] }` immediately without contacting Daytona.
- Admin UI surfaces circuit state per upstream.

### B8. Cost projection sketch

Daytona Cloud's published pricing model is per-sandbox-second of active CPU. Worked example for a team of 20:
- Assume 5 stdio upstreams enabled, average user has 2 stdio sessions active during work hours (8h).
- Peak concurrent active sandboxes ≈ 20 × 2 = 40.
- At ~$0.05/hour per small sandbox (estimate; confirm against current pricing): 40 × 8 × $0.05 ≈ $16/day ≈ $480/month.
- Aggressive `idleTimeoutSeconds=300` reduces wasted runtime considerably (sandbox sleeps between minutes-long agent pauses).
- Surface estimated cost in admin UI from `(running sandbox-minutes from sandbox_sessions)`.

---

## C. Upstream proxy mechanics — deep dive

### C1. `tools/list` aggregation algorithm

```
async function listTools(): Promise<Tool[]> {
  const builtins = [searchDocsTool, getDocTool, listUpstreamsTool]
  const enabled = await db.upstreamsEnabledForUser(this.props.userId)
  const proxied: Tool[] = []
  for (const u of enabled) {
    const cached = await db.upstreamToolsCached(u.id)
    if (!cached.length) continue   // skip silently; no entry better than stale ghost
    for (const t of cached) {
      proxied.push({
        name: mangle(u.slug, t.tool_name),
        description: `[${u.display_name}] ${t.description ?? ''}`.slice(0, 1024),
        inputSchema: JSON.parse(t.input_schema),
      })
    }
  }
  return [...builtins, ...proxied]
}
```

Cache freshness is a property of the row (`cached_at`); a session-start refresh job fires `client.listTools()` on each connected upstream and overwrites rows older than 24h. The session does NOT wait on this — the user gets cached tools immediately and the next session benefits from the refresh.

### C2. Namespacing edge cases

| Case | Strategy |
|---|---|
| Upstream tool name contains `__` | Escape upstream side to `_~_`, unescape on dispatch. Documented as a reserved separator. |
| Upstream slug starts with a digit or contains `-` | MCP tool names allow `[a-zA-Z0-9_-]`; we restrict slugs to `[a-z][a-z0-9_]*` (≤24 chars) at admin form validation. |
| Two upstreams export the same tool name | Each is namespaced; collision impossible after mangling. `list_upstreams` and `search_docs` are reserved as built-ins; admins cannot create a slug = built-in name. |
| Tool description >1024 chars | Truncated with `…` to keep client UIs sane. |
| Upstream renames a tool between catalogue refreshes | Old name disappears from next `tools/list`; outstanding `tools/call` returns `{code:-32601, message:"tool no longer available"}`. |

### C3. Lazy connect — cost analysis

| Path | Sync work in tool/call hot path |
|---|---|
| First `tools/call` to upstream `notion__create_page` (HTTP) | DNS + TLS + MCP `initialize` + tool dispatch. ~150-400ms warm; ~600ms cold. Acceptable. |
| First `tools/call` for `github_stdio__create_issue` (Daytona) | Sandbox wake (~150-300ms if existing) OR create (~500-1500ms cold) + supergateway start + tool dispatch. Cold path can exceed 1s; mitigated by snapshot pre-baking + concurrent sandbox start triggered by a hint on `tools/list` (see below). |
| Subsequent calls within session | Re-use Client. ~30-80ms. |
| Subsequent calls after Daytona auto-stop | Wake (~150-300ms) — cheap. |

Optimisation: when a session opens, kick off a `ctx.waitUntil` that starts (not creates) sandboxes for any stdio upstream the user has credentials for. Doesn't block `initialize`, but the first real tool/call usually finds the sandbox already running. Disabled by default; opt-in per upstream (`auth_config.warmOnSessionStart=true`) to avoid spending sandbox-seconds when the agent never actually uses that upstream.

### C4. Error surface taxonomy

| Layer | What client sees |
|---|---|
| Upstream returns JSON-RPC error | Passed through verbatim, `code` preserved. |
| Upstream returns `result` with `isError:true` | Passed through verbatim. |
| Upstream timeout (60s wall) | `{code:-32603, message:"Upstream {slug} timed out"}` |
| Upstream HTTP 5xx / connection refused | `{code:-32603, message:"Upstream {slug} unavailable: <category>"}` (category in `data.category`) |
| Credential refresh failed (e.g. revoked refresh token) | `{code:-32001, message:"Reauthenticate {slug}: visit https://.../upstreams"}` |
| Daytona create failed (quota) | `{code:-32002, message:"Sandbox quota exceeded; ask admin"}` |
| Daytona create failed (snapshot missing) | `{code:-32003, message:"Upstream {slug} not provisioned"}` (admin error) |
| Circuit breaker open | `{code:-32004, message:"Upstream {slug} temporarily disabled"}` |

`-3200x` codes are within MCP's reserved server-error range and clients pass them through.

### C5. Streaming long upstream responses

- All transports return responses as `ReadableStream` of JSON-RPC frames.
- Worker code does **not** `.text()` or buffer the upstream body. It pipes:
  ```ts
  const upstreamRes = await upstreamClient.callTool(...)
  return new Response(upstreamRes.body, {
    headers: { 'content-type': 'application/jsonl', ... }
  })
  ```
- CPU time consumed only while bytes are flowing through. Idle wait (TCP read) is wall time, not CPU.
- A 60s `AbortController` wraps the upstream fetch; on abort we send a final `{error: -32603, timeout: true}` frame.

### C6. Subrequest accounting

- Each upstream tool call = 1 outbound `fetch`. Workers paid plan = 1000 subrequests per request, way more than any sane session.
- Catalogue refresh on session start = 1 `client.listTools()` per upstream = 1 fetch each. With 10 upstreams, that's 10 subrequests up-front, well within budget.

### C7. Concurrent tool calls within one session

- `McpSessionDO` is a DO and processes requests serially. An MCP client doing parallel `tools/call` (some do) will queue.
- For high-traffic sessions this serialisation is the bottleneck. Mitigation if needed in v2: have the DO act as a dispatcher and `fetch` to sibling stateless workers for the actual upstream call. For v1 we accept the serial limit — most agents call one tool at a time anyway.

### C8. `list_upstreams()` shape

```jsonc
[
  { "slug": "notion",  "displayName": "Notion",  "transport": "streamable_http",
    "connected": true,  "toolsCount": 7, "lastCalledAt": 1716480000 },
  { "slug": "linear",  "displayName": "Linear",  "transport": "streamable_http",
    "connected": false, "requiresAuth": "user_oauth",
    "connectUrl": "https://ctx.acme.com/app/upstreams?upstream=linear" },
  { "slug": "github_stdio", "displayName": "GitHub (stdio)", "transport": "stdio_daytona",
    "connected": true, "sandboxState": "idle" }
]
```

Agents call this proactively to know which proxied tools they can rely on. Disconnected ones include a deep link the agent can give the user.

---

## D. UI surface + REST endpoints

### D1. Sitemap

```
/                           -> redirect: signed in ? /app/docs : /sign-in
/sign-in                    -> Google + GitHub chooser
/idp/google/start           -> redirect to Google
/idp/google/callback        -> Google OIDC callback
/idp/github/start           -> redirect to GitHub
/idp/github/callback        -> GitHub OAuth callback
/oauth/*                    -> workers-oauth-provider (DCR, authorize, token, revoke)
/mcp                        -> Streamable HTTP MCP endpoint
/sse                        -> SSE MCP endpoint
/collab/:docId              -> WebSocket upgrade for Yjs
/api/*                      -> REST (see D5)

# SPA (Workers Assets) — all client-side routed
/app/docs                   -> doc library list
/app/docs/new
/app/docs/:id               -> BlockNote editor + Yjs
/app/docs/:id/revisions
/app/upstreams              -> connect wizard cards
/app/mcp-setup              -> setup instructions + token generator
/app/usage                  -> personal stats
/app/profile                -> name/email, signout
/app/admin/upstreams        -> CRUD upstreams
/app/admin/users            -> users list + role mgmt
/app/admin/usage            -> dashboards
/app/admin/sandboxes        -> live + archived sandboxes
/app/admin/oauth-clients    -> issued MCP clients
/app/admin/audit            -> audit log tail
/app/admin/docs             -> same as user docs + delete + rename
```

### D2. User screens (wireframes-in-text)

**`/sign-in`**
```
┌────────────────────────────────────────────┐
│              ctxlayer                      │
│   The agent context layer for {ORG}        │
│                                            │
│   [ Sign in with Google     ]              │
│   [ Sign in with GitHub     ]              │
│                                            │
│   Only @acme.com Google accounts and       │
│   @acme-inc GitHub members can sign in.    │
└────────────────────────────────────────────┘
```
On error: subtle banner ("Your account isn't in the allowed org.").

**`/app/docs`** (default landing after sign-in)
```
┌─────────────┬──────────────────────────────────────────────────┐
│ ctxlayer    │  Docs library                       [+ New doc]  │
│             │  ┌────────────────────────────────────────────┐  │
│ Docs        │  │ q search...                                │  │
│ Upstreams   │  └────────────────────────────────────────────┘  │
│ MCP setup   │                                                   │
│ Usage       │  ▸ Engineering ▾                                  │
│             │     • SRE runbooks         updated 3h ago         │
│ Admin       │     • API guidelines       updated yesterday      │
│ • Upstreams │  ▸ Product ▸                                     │
│ • Users     │  ▸ Prompts ▸                                     │
│ • Usage     │                                                   │
│ • Audit     │                                                   │
└─────────────┴──────────────────────────────────────────────────┘
```

**`/app/docs/:id`** — BlockNote editor occupies the canvas; left nav stays. A presence avatar strip in the header shows other connected editors. Top-right: "Revisions" opens a side drawer listing recent `doc_revisions` rows with restore.

**`/app/upstreams`**
```
Connect your tools

┌─ Notion ───────────────────── [HTTP] ─┐  ┌─ Linear ─────────────── [OAuth] ─┐
│ Status: Not connected                  │  │ Status: Connected (expires 5d) │
│ Auth: paste your Notion integration   │  │ [ Reconnect ]  [ Disconnect ]   │
│ token from notion.com/integrations    │  └─────────────────────────────────┘
│ [ ghp_____________________ ] [Save]   │
└────────────────────────────────────────┘
┌─ GitHub (stdio) ────────────── [PAT] ─┐  ┌─ Filesystem ─────────── [Shared]─┐
│ Status: Not connected                  │  │ Configured by admin (read-only) │
│ Sandbox: starts on first use           │  │ Status: Available to everyone   │
│ [ ghp_____________________ ] [Save]   │  └─────────────────────────────────┘
└────────────────────────────────────────┘
```

**`/app/mcp-setup`**
```
Connect ctxlayer to your AI tool

Server URL:  https://ctx.acme.com/mcp                     [Copy]
Auth:        OAuth (preferred) or paste a token

▸ Claude Desktop — preferred (OAuth via DCR)
  1. Open Settings → Developer → Edit Config
  2. Add this server block:
     {
       "mcpServers": {
         "ctxlayer": { "url": "https://ctx.acme.com/mcp" }
       }
     }
  3. Restart Claude Desktop. It will open ctxlayer in your browser to sign in.
  [Copy snippet]

▸ Cursor / Windsurf / others without DCR — paste-bearer fallback
  [Generate token]  -> shows ctx_pat_xxxx (valid 90d)
  Then paste into the client's config under Authorization: Bearer.
```

**`/app/usage`** — three small stat cards (today / 7d / 30d: calls, tokens-in, tokens-out), a line chart of calls/day, a horizontal bar of top tools.

### D3. Admin screens

**`/app/admin/upstreams`** — sortable list, columns: Slug, Name, Transport, Auth strategy, Users connected, Last call. Row click → edit modal:
- Common fields: slug, display_name, transport (`streamable_http`|`sse`|`stdio_daytona`), enabled toggle.
- Conditional fields by transport:
  - `streamable_http`/`sse`: URL.
  - `stdio_daytona`: snapshotId picker (lists snapshots from `infra/daytona-snapshots/`), startCommand, bridgePort (default 8080), envTemplate JSON editor, idleTimeoutSeconds.
- Conditional fields by auth strategy:
  - `shared_bearer`: bearer input (encrypted on save).
  - `user_oauth`: client_id, client_secret, authorize_url, token_url, scopes (space-separated).
- Buttons: "Test connection" (transport check; for stdio, briefly create a no-credential probe sandbox and call `tools/list`), "Refresh tool cache".

**`/app/admin/users`** — table: avatar, email, IdP, role, last seen, 30d calls, connected upstreams count. Row click → drawer with promote/demote, revoke all credentials, force sign-out (deletes their OAuth tokens from `OAUTH_KV`).

**`/app/admin/usage`** — date-range picker, group-by selector (user | upstream | tool), line + stacked bar + top-N tables. Drill-down link from any row to a filtered view. Underlying queries hit `usage_rollups_daily`.

**`/app/admin/sandboxes`** — live table from Daytona API joined with `sandbox_sessions`. Columns: User, Upstream, State (running/idle/archived), Started, Last active, Cost-est. Force-destroy button per row, bulk destroy for an upstream.

**`/app/admin/oauth-clients`** — list of issued OAuth clients (reads `OAUTH_KV`). Columns: client_id, registered, last used, redirect URIs, owner_user_id. Revoke purges tokens for that client.

**`/app/admin/audit`** — virtualised tail of `audit_log`. Filters: actor, action, target. Export-to-CSV.

### D4. Role gating

- Server-side: every `/api/admin/*` route in Hono goes through a `requireAdmin` middleware that re-reads `users.role` from D1 (don't trust the SPA cookie's role alone — refresh on each request).
- Client-side: a `useMe()` hook fetches `/api/me` once per session; admin nav items render only if `role==='admin'`. Cosmetic only.

### D5. REST endpoint catalogue

All under `/api`. JSON in / JSON out. CSRF token required for unsafe methods (`X-CSRF` header).

```
GET    /api/me                              -> { id, email, name, role, idp, lastSeenAt }
POST   /api/auth/signout                    -> 204
GET    /api/docs                            -> [{ id, title, slug, updatedAt, kind }]
POST   /api/docs                            -> { id, slug } (creates empty doc)
GET    /api/docs/:id                        -> { id, title, slug, kind, currentRevId, lastUpdatedBy }
PATCH  /api/docs/:id                        -> { title?, slug?, kind? }  (rename etc.)
DELETE /api/docs/:id                        -> 204 (soft delete)
GET    /api/docs/:id/revisions              -> [{ id, authorId, createdAt, byteSize }]
GET    /api/docs/:id/revisions/:rev         -> markdown text/plain
POST   /api/docs/:id/restore                -> { revisionId } -> 204

GET    /api/upstreams                       -> [{ id, slug, name, transport, authStrategy, enabled, connected }]
                                               (user-shaped; connected reflects calling user's credentials)
POST   /api/upstreams/:id/credentials       -> { kind:'bearer', token }   -> 204
DELETE /api/upstreams/:id/credentials       -> 204
GET    /api/upstreams/:id/oauth/start?return_to=  -> 302
GET    /api/upstreams/:id/oauth/callback    -> 302 to return_to

GET    /api/usage/me?from=&to=&group=       -> [{ key, calls, reqBytes, respBytes, reqTokens, respTokens, errors }]

# admin only
GET    /api/admin/upstreams                 -> full rows (with auth_config sans secrets)
POST   /api/admin/upstreams                 -> { ...full body } -> { id }
PATCH  /api/admin/upstreams/:id             -> partial -> 204
DELETE /api/admin/upstreams/:id             -> 204
POST   /api/admin/upstreams/:id/test        -> { ok, latencyMs, toolsCount } | { ok:false, error }
POST   /api/admin/upstreams/:id/refresh     -> { toolsCount } (re-cache catalogue)

GET    /api/admin/users                     -> rows + denormalised stats
POST   /api/admin/users/:id/role            -> { role:'admin'|'user' } -> 204
POST   /api/admin/users/:id/credentials/revoke_all -> 204
POST   /api/admin/users/:id/sessions/revoke -> 204

GET    /api/admin/usage?...                 -> series + tables
GET    /api/admin/sandboxes                 -> live joined view
DELETE /api/admin/sandboxes/:sandboxId      -> 204 (force destroy via Daytona)

GET    /api/admin/oauth-clients             -> rows from OAUTH_KV
POST   /api/admin/oauth-clients/:id/revoke  -> 204
GET    /api/admin/audit?from=&to=&actor=    -> rows

GET    /api/health                          -> { ok, dependencies:[{name, ok, latencyMs}] }
GET    /api/version                         -> { gitSha, builtAt }
```

`packages/shared/src/api-types.ts` defines a Zod schema for every endpoint body; both the Hono route and the React fetch helper import the same types. End-to-end type safety without an RPC framework.

---

## E. Dev environment and team experience

The repo is built to be operated **primarily from cloud Claude sessions (including mobile)** with local dev as a fallback. Every workflow that a human would do via VS Code must also be doable by typing into a chat box.

### E1. Cloud-native session bootstrap

- **`.claude/settings.json`** at the repo root with:
  - `permissions.allow` allowlist tailored for this project's common commands (`bun *`, `bunx *`, `wrangler d1 *`, `wrangler tail`, `git status|log|diff|add|commit|push`, `gh pr *`).
  - A **SessionStart hook** that runs `bun install --frozen-lockfile` and `bun run env:check` so every new web/mobile session is ready to run/test in ≤30s.
  - Environment variables setting `WRANGLER_DEV_REGISTRY` and `WRANGLER_LOG=warn` to keep output mobile-readable.
- **`CLAUDE.md`** at root: 1-page architecture briefing + pointers to key files. Future Claude sessions land here first.
- **`.claude/commands/*`** custom slash commands tuned for this project:
  - `/migrate` — apply pending D1 migrations to the local + dev environment, print diff.
  - `/seed` — load fixture upstreams + docs into local D1 for demos.
  - `/snapshot <slug>` — rebuild a single Daytona snapshot.
  - `/deploy:preview` — wrangler versions deploy + post preview URL to the conversation.
  - `/smoke` — runs the cross-cutting smoke harness (see E5) and prints a status table.

### E2. Local dev DX (for when someone *is* at a desktop)

- `bun run dev` starts:
  - Vite dev server for the SPA on `:5173`.
  - `wrangler dev --persist-to .wrangler/state` for the Worker on `:8787` with **Miniflare** local emulation: D1 (sqlite file), KV (sqlite), R2 (filesystem), Queues (in-memory), Durable Objects.
  - A small `mock-daytona` process on `:9000` (Node) implementing the subset of Daytona's API we use, backed by `docker run` locally. Toggled by env `DAYTONA_API_URL=http://localhost:9000`.
- `bun run dev:no-daytona` — same but with the Daytona client stubbed to "stdio upstreams disabled" (useful when Docker isn't around, e.g. cloud sessions without privileged containers).
- `.dev.vars.example` checked in with placeholders; `.dev.vars` gitignored. `bun run setup` copies the example and prompts for the secrets you need (or accepts a `--non-interactive` flag for cloud sessions to use sensible test defaults).

### E3. Test harness (cloud + local parity)

Three layers, all runnable as `bun run test`, `bun run test:int`, `bun run test:e2e`:

| Layer | Runner | Scope | When |
|---|---|---|---|
| Unit | Vitest | Pure functions (chunker, token estimator, allowlist, namespacing, AES-GCM wrapper). ≤200ms per file. | Every change, every PR. |
| Integration | Vitest + `@cloudflare/vitest-pool-workers` | Worker handlers + DOs against Miniflare. Includes OAuth happy/sad paths with a fake IdP, MCP `initialize`/`tools/list`/`tools/call`, DocRoom Yjs sync, queue consumer behaviour, mock-Daytona sandbox lifecycle. | Every PR + nightly. |
| End-to-end | Playwright | SPA sign-in, doc edit (two browsers), upstream connect, MCP setup, admin CRUD. Runs against a `wrangler versions deploy` preview URL. | PR + before promote-to-prod. |

Special harnesses:
- `tests/fixtures/fake-idp/` — minimal OIDC issuer + GitHub-shaped API for Google and GitHub allowlist tests. No external dependency.
- `tests/fixtures/fake-upstream-mcp/` — a tiny in-process MCP server (Streamable HTTP) that the integration tests register as an upstream. Verifies proxy + namespacing + error surfacing end-to-end.
- `tests/fixtures/mock-daytona/` — express server speaking Daytona's REST API shape; sandbox state machine is purely in-memory. Lets integration tests cover the stdio path without any container runtime.

### E4. CI/CD

- **GitHub Actions** workflows:
  - `pr.yml`: install → typecheck → lint → unit + integration tests → `wrangler versions deploy --preview` → post preview URL as PR comment.
  - `main.yml`: same as PR + E2E against preview → on green, `wrangler deploy` to production environment.
  - `snapshots-nightly.yml`: runs `infra/daytona-snapshots/build-and-push.ts`, opens a PR if any snapshot's pinned package version drifted.
  - `prune.yml` (cron): clears old `usage_events`, archives stale `doc_revisions` to R2.
- **Branch model**: trunk-based on `main`, every change goes through a PR with preview deploy. Wrangler "environments" (`preview`, `production`) bind to different D1 databases and Daytona organisations.

### E5. Mobile / chat-driven workflow

Optimisations specifically for typing into Claude on a phone:

- **`/smoke` slash command** — single command that:
  1. Deploys a preview.
  2. Hits a hard-coded set of endpoints (`/api/health`, `/api/me` with a baked-in test token, `/mcp` `initialize` + `tools/list`).
  3. Returns a compact text status table — no screenshots required.
- **Verbose-by-default scripts**: every `bun run` script prints what it's about to do and a single-line summary on completion. No spinners (mobile transcripts hate them).
- **`bun run verify`** — composite command: typecheck + unit + integration + smoke. Returns a final pass/fail table. Designed to fit on one phone screen.
- **`wrangler tail` aliases** — `bun run logs` (errors only), `bun run logs:all`, `bun run logs:mcp` (filtered to /mcp routes). All print as plain text.
- **Curl-bot test tokens** — a long-lived non-prod OAuth client whose secret is in CI secret env vars, used by smoke scripts. Scoped to a "test" user that doesn't appear in real usage rollups.
- **`AGENTS.md`** — opinionated "how a Claude agent should make changes in this repo" file alongside `CLAUDE.md`: where types live, what to run before pushing, the strict module-size cap (~200 lines), the test-first cadence. Reduces token cost of every future session.
- **Repository-level `.claude/output-style.json`** sets terse, mobile-friendly defaults for AI replies in this repo.

### E6. Module conventions

To keep AI agents (and humans) productive at scale:
- Hard cap modules at ~200 LoC. Split when it grows.
- One folder = one concern. No circular imports across `apps/worker/src/*` directories.
- Every Hono route handler lives in `api/*` with a one-line export; route-mounting happens centrally in `index.ts`.
- Every DO class has the file pattern `*-do.ts` and the only export is the class.
- D1 queries live in `db/queries/*.ts` and never leak SQL into route files; queries return typed objects matching `packages/shared`.
- All env access goes through `env.ts` typed bindings — `process.env` is forbidden.

### E7. Observability for the team

- **Logpush** to R2 (or to a third party if the org has one) for `wrangler` logs, retained 7 days.
- **Sentry** (free tier or self-hosted) for unhandled exceptions in Worker + SPA. DSN in vars.
- **Cloudflare Analytics Engine** binding for high-cardinality custom metrics (per-tool latency, error rates) — cheaper than D1 for write-heavy series. Powers the admin "system health" sub-page.
- **Cron health check** — every cron run records its outcome in `audit_log` so silent cron failures are visible.

### E8. New env vars / secrets summary

Added by Section E:
- Vars: `MOCK_DAYTONA_URL` (only set in `wrangler dev`), `SENTRY_DSN_WORKER`, `SENTRY_DSN_WEB`, `LOGPUSH_ENABLED`.
- Secrets: `CI_SMOKE_OAUTH_CLIENT_ID`, `CI_SMOKE_OAUTH_CLIENT_SECRET`.

### E9. Onboarding checklist (target: a new team member productive in 1 hour, including via mobile)

1. Sign in to claude.ai/code, open the ctxlayer repo as a web session.
2. Run `/smoke` to confirm the preview deploy works.
3. Read `CLAUDE.md` (5min).
4. Run `bun run verify` locally OR in the cloud session.
5. Pick a "good first issue" labelled task — every milestone backlog item is sized to fit one PR ≤ 400 LoC.

---

## F. Org information architecture — teams, products, and access

Each ctxlayer deployment is **a separate install for one org**. Inside the
org we model two orthogonal groupings:

- **Teams** — who people belong to (`platform`, `web-frontend`, `infra`).
- **Products** — what the org delivers (`checkout`, `search`, `billing`).
- Teams are assigned to products (many-to-many). Users belong to teams
  (many-to-many). Product membership is transitive through team.

Defaults are tuned to **spread context, gate execution**:

| Surface | Default | Centrally controlled |
|---|---|---|
| Docs | Open-read for everyone signed in. | Admins manage tags; tags drive filtering, not access. |
| MCP upstreams | New upstreams visible to **no one**. | Admins grant per team or per product. |
| `search_docs` | Filters to user's teams ∪ products ∪ untagged "global" docs. | `scope:'all'` overrides. |
| `list_upstreams` | Returns only what the user can use. | (No escape hatch — that IS the access list.) |

### F1. Data model additions (`0004_org_ia.sql`)

```sql
CREATE TABLE teams (
  id           TEXT PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  description  TEXT,
  -- Reserved for future IdP sync: 'google:<group-email>' | 'github:<org>/<team-slug>'.
  -- v1 ignores this field at sign-in time; admin manages members manually.
  idp_group    TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE products (
  id           TEXT PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  description  TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE team_members (
  team_id    TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'member',   -- 'member' | 'lead'
  created_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX idx_team_members_user ON team_members(user_id);

CREATE TABLE team_products (
  team_id    TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  PRIMARY KEY (team_id, product_id)
);
CREATE INDEX idx_team_products_product ON team_products(product_id);

-- Visibility scope for upstream MCP servers. Additive: a user has access
-- if ANY row matches. New upstreams have zero rows → invisible until an
-- admin grants.
CREATE TABLE upstream_visibility (
  upstream_id TEXT NOT NULL REFERENCES upstream_servers(id) ON DELETE CASCADE,
  scope_kind  TEXT NOT NULL,                  -- 'everyone' | 'team' | 'product'
  scope_id    TEXT,                           -- team_id | product_id | NULL for 'everyone'
  PRIMARY KEY (upstream_id, scope_kind, COALESCE(scope_id, ''))
);

-- Tags on documents. Used for filtering / shaping default agent context.
-- Does NOT gate read access — every signed-in user can read every
-- non-deleted document.
CREATE TABLE doc_tags (
  doc_id    TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  tag_kind  TEXT NOT NULL,                    -- 'team' | 'product' | 'topic'
  tag_value TEXT NOT NULL,                    -- team_id | product_id | free-form topic slug
  PRIMARY KEY (doc_id, tag_kind, tag_value)
);
CREATE INDEX idx_doc_tags_lookup ON doc_tags(tag_kind, tag_value);
```

### F2. Access resolution

The single query backing `tools/list` filtering and the admin "which
upstreams can this user see" view:

```sql
SELECT DISTINCT us.*
FROM upstream_servers us
JOIN upstream_visibility uv ON uv.upstream_id = us.id
WHERE us.enabled = 1
  AND (
    uv.scope_kind = 'everyone'
    OR (uv.scope_kind = 'team'
        AND uv.scope_id IN (SELECT team_id FROM team_members WHERE user_id = ?))
    OR (uv.scope_kind = 'product'
        AND uv.scope_id IN (
          SELECT tp.product_id
          FROM team_products tp
          JOIN team_members tm ON tm.team_id = tp.team_id
          WHERE tm.user_id = ?
        ))
  );
```

The same predicate, in TS, lives in `apps/worker/src/db/queries/access.ts`
so route handlers and the MCP layer share one source of truth.

### F3. Search default scope

When the agent calls `search_docs({query, k, scope?})`:

- **omitted** — build a Vectorize metadata filter:
  `tag_team IN user_teams OR tag_product IN user_products OR is_global=true`.
  "Global" = a doc with zero team/product tags (it may still have topic
  tags). Untagged docs are everyone's by design.
- **`scope: 'all'`** — drop the filter.
- **`scope: { teams?: [...], products?: [...] }`** — explicit; intersected
  with what the user belongs to so an agent can't elevate.

Chunk metadata stored in Vectorize when (re)indexing a doc:
`{ docId, chunkIdx, revisionId, title, tag_teams: [team_id, ...], tag_products: [...], is_global: bool }`.

### F4. New + changed built-in MCP tools

- `list_upstreams()` — unchanged shape; already user-scoped via F2.
- `search_docs(query, k, scope?)` — adds the optional `scope` arg per F3.
  Each result also carries the doc's tags so the agent can cite scope.
- **New** `list_my_context()` →
  `{ teams: [{slug, displayName, role}], products: [{slug, displayName}], accessibleUpstreams: [slug, ...], defaultScope: {teams: [...], products: [...]} }`.
  Cheap, no upstream calls. Helps an agent self-orient at session start.

### F5. Admin UI additions

- **`/app/admin/teams`** — CRUD; row → drawer with member table
  (add/remove users by email; role: member|lead) plus a read-only
  `idp_group` field reserved for future sync.
- **`/app/admin/products`** — CRUD (slug, display_name, description).
- **`/app/admin/team-products`** — a teams×products matrix with checkbox
  cells; one save per change (`PATCH /api/admin/team-products`).
- **`/app/admin/upstreams`** edit form — new "Visibility" section:
  radio `Everyone | Specific teams | Specific products | Combination`,
  multi-selects revealed by the choice. Combinations are additive.
  Default on create: empty → invisible until granted. The form shows a
  live "users with access: N" counter before save.
- **`/app/admin/docs`** and `/app/docs/:id` editor — tag editor pane:
  team multi-select, product multi-select, free-form topic-tag chips.

### F6. REST endpoints (additions to D5)

```
GET    /api/me/context                 -> { teams, products, accessibleUpstreams }
GET    /api/teams                      -> [{ id, slug, displayName }]      (public org-wide)
GET    /api/products                   -> [{ id, slug, displayName }]      (public org-wide)
GET    /api/docs/:id/tags              -> { teams:[...], products:[...], topics:[...] }
PUT    /api/docs/:id/tags              -> body: same shape                  (author + admin)

GET    /api/admin/teams
POST   /api/admin/teams                -> { slug, displayName, description?, idpGroup? }
PATCH  /api/admin/teams/:id
DELETE /api/admin/teams/:id
GET    /api/admin/teams/:id/members
POST   /api/admin/teams/:id/members    -> { userId, role? }
DELETE /api/admin/teams/:id/members/:userId

GET    /api/admin/products
POST   /api/admin/products
PATCH  /api/admin/products/:id
DELETE /api/admin/products/:id

GET    /api/admin/team-products        -> [{ teamId, productId }]
PUT    /api/admin/team-products        -> { adds:[...], removes:[...] }

GET    /api/admin/upstreams/:id/visibility -> [{ scopeKind, scopeId }]
PUT    /api/admin/upstreams/:id/visibility -> { rules:[...] }               (admin replaces full set)
```

All in `packages/shared/src/api-types.ts` with Zod schemas; SPA's typed
`api.ts` consumes the same shapes.

### F7. Milestone impact

- **M1** (+~0.5 day): ship migration `0004_org_ia.sql` alongside
  `0001`–`0003`. Empty `teams`/`products` tables. SPA admin pages can
  render with "no teams yet" copy.
- **M2**: persist tag metadata into Vectorize during reindex. Tag editor
  pane in the doc editor. `search_docs` honours `scope`.
- **M4**: `upstream_visibility` enforced in `tools/list` aggregation
  (Section C1). Admin REST writes the visibility rules.
- **M5**: full admin UI for teams / products / team-products / visibility
  editor on the upstream form.

### F8. Future IdP sync (not in v1)

When we enable it later:

- `teams.idp_group` formats:
  - `google:<group-email@acme.com>` — needs Google Workspace Directory API
    `groups.list` + `members.list`; admin-consented scope
    `admin.directory.group.member.readonly`.
  - `github:<org>/<team-slug>` — needs the `read:org` GitHub scope at
    sign-in.
- Sync runs:
  - On each sign-in for the calling user (just their groups; fast).
  - Nightly cron for full reconciliation across all `idp_group`-bound teams.
- Direction: IdP → ctxlayer. Memberships added manually remain unless the
  team is flipped to `managed_by_idp = true` (future column).

### F9. UX guardrails

- Doc editor's tag pane carries a one-line hint: "Tags help people and
  agents find this doc. Anyone in the org can still read it." — to
  prevent the confusion that tags == ACL.
- The admin upstream-visibility editor shows a live "users with access:
  N" counter so the admin sees the blast radius before saving.
- `list_my_context()` is documented in the MCP setup page so agent authors
  know to call it once at session start.

### F10. Risks

- **Discoverability vs. relevance** — over-aggressive default filtering
  can hide useful org-wide context. Mitigation: untagged docs are always
  included; `scope:'all'` is one keyword away; admin dashboards show
  per-tag doc counts so curators see imbalance.
- **Tag drift** — free-form topic tags will multiply. Admin "Topic tags"
  page with rename/merge tools (M5+).
- **Admin onboarding gap** — fresh install has no teams/products and no
  upstream visibility, so no user sees any proxied tools until setup is
  done. The admin dashboard shows a top-banner first-time-setup checklist.

---

## G. Conventions captured by the M1 scaffold

Findings from the M1 scaffold pass + multi-angle code review (~30
candidates surfaced, ~25 fixed in place). These are the load-bearing
gotchas the rest of the build should respect.

### G1. SQLite / D1

- **No expressions in `PRIMARY KEY`**. SQLite rejects
  `PRIMARY KEY (a, COALESCE(b, ''))`. When the conceptual key has a
  nullable "self" column, use an empty-string sentinel on `NOT NULL`
  columns and a partial `UNIQUE INDEX … WHERE col = 'sentinel'` to
  enforce uniqueness. See `usage_rollups_daily.upstream_id` (`''` =
  built-in / self) and `upstream_visibility.scope_id` (`''` =
  `scope_kind='everyone'`).
- **CHECK every enum-shaped column**. Every column whose Zod schema
  is an `enum(...)` has a matching `CHECK (col IN (...))` in SQL.
  Examples: `users.role`, `users.idp`, `upstream_servers.transport`,
  `upstream_servers.auth_strategy`, `documents.kind`,
  `usage_events.status`, `team_members.role`, `doc_tags.tag_kind`,
  `upstream_visibility.scope_kind`. Keeps ad-hoc `wrangler d1 execute`
  edits from inserting values the SPA can't render.

### G2. Cloudflare Workers Assets

- **SPA fallback belongs to Assets, not Hono.** Set
  `not_found_handling = "single-page-application"` in `[assets]` and
  let the asset resolver serve `/index.html` for unknown non-API paths.
  A hand-rolled `app.notFound` that re-fetches `ASSETS` is fragile
  (Request body re-use, POST→/index.html→405, etc.) and unnecessary.
- **`run_worker_first` requires both bare + glob paths.** Routes like
  `/mcp` and `/mcp/*` must both appear, because the Worker may handle
  both the session-initiation request and per-session subpaths.
- **`apps/web/dist` must exist before `wrangler dev`/`deploy`.** A
  cold checkout has no dist directory. `scripts/ensure-dist.mjs` lays
  a placeholder `index.html`; `predev`/`prebuild`/`predeploy` hooks in
  `apps/worker/package.json` run it automatically.

### G3. Durable Objects

- **Storage backend is sticky.** Choosing `new_sqlite_classes` at first
  migration is irreversible — the class is permanently SQLite-backed.
  For stubs that don't use `ctx.storage.sql`, declare them under
  `new_classes`. Promote to SQLite in a later migration tag when SQL
  state actually lands.

### G4. Hono / Workers entry

- Type the entry as `ExportedHandler<Env>` so `queue` receives a typed
  `ctx: ExecutionContext` and `scheduled` receives a
  `ScheduledController` (not the legacy `ScheduledEvent`). Without
  `ctx`, queue consumers can't `waitUntil` post-ack work.
- **Queue dispatcher must handle unknown queue names.** Silently
  returning `undefined` drops the batch. Log + `msg.retry()` instead.
- **Consumers wrap each message in try/catch.** A poison message that
  throws before `ack()` stalls the whole batch. Until a dead-letter
  queue is configured, per-message `retry()` is the safety valve.

### G5. Bun

- **`packageManager` is pinned.** `bun@1.3.x` minimum. `engines.bun >=1.3`
  is advisory; the `packageManager` field is the hard gate.
- **`bun install --frozen-lockfile` does NOT fail on missing lockfile.**
  The SessionStart hook explicitly tests for `bun.lock` first and
  refuses to install otherwise.
- **`bun --filter='*' run <script>` silently skips workspaces missing
  the script.** Every workspace must declare stubs for `typecheck`,
  `lint`, `test` (even `echo 'no tests yet'`) so cross-cuts catch
  workspaces, not just whichever happened to have a real script.

### G6. Schemas and API boundaries

- **`.nullish()` for optional response fields.** `JSON.stringify` drops
  `undefined`, so a server that omits a nullable field would otherwise
  fail strict `.nullable()` parsing in the SPA. Use `.nullish()` (=
  `.nullable().optional()`).
- **Known-enum + open-string union for forward-compatible enums.**
  `KnownIdp = z.enum(['google','github'])` + `Idp = KnownIdp |
  z.string()` lets an OIDC provider land in M5 without breaking
  existing clients. Same pattern when adding values is plausible.
- **Distinguish HTTP failure from schema failure in fetch helpers.**
  `ApiError(status)` vs `ApiSchemaError(path, cause)`. Treating any
  failure as "not signed in" caused a redirect loop on schema drift;
  the SPA now surfaces parse errors as visible UI and only redirects
  on 401.

### G7. Wrangler CLI

- `wrangler versions upload` is the preview/staging command in wrangler
  4. The old `wrangler versions deploy --x-versions` flag was retired.
- D1/KV/Vectorize/R2 IDs in `wrangler.toml` are placeholder UUIDs
  (`00000000-…`). They're documented `<TODO>`s; runtime endpoints that
  touch the bindings return 503 (e.g. `/api/health`) until real IDs
  are populated.

### G8. SPA conventions

- **Sign-in buttons are gated on configured IdPs.** `/api/config`
  returns the list of providers whose env vars are set
  (`ALLOWED_GOOGLE_HD`, `ALLOWED_GITHUB_ORG`); the SPA renders only
  those buttons, with a clear "no IdPs configured" message when both
  are empty.
- **No anchors wrapping buttons.** Use `<button onClick={...}>` for
  actions; reserve `<a>` for in-app navigation.
- **All effects use `AbortController`.** Cleanup aborts in-flight
  fetches so StrictMode double-invokes and unmount races don't leak
  state.
- **Admin nav items have matching routes from M1.** Even M5 admin
  pages render a "coming in M5" stub Route so clicks don't silently
  bounce to `/app/docs`.

### G9. Smoke and seed scripts

- `scripts/seed.mjs` defaults to `--local`; `--remote` requires the
  explicit flag plus a 3-second abort window.
- `scripts/smoke.mjs` env-toggles expectations (`SMOKE_ME_OK=1` widens
  `/api/me` to `[200, 401]` for sessioned CI). New checks must declare
  realistic expected status sets — not `[200, 404]` "to be safe", which
  masks broken SPA dists.

### G10. Admin/UX guardrails to remember in M5

The full set of admin onboarding guardrails (visibility blast-radius
counter, "tags ≠ ACL" hint, first-time-setup banner) lives in
Section F9. Wire them in as the admin UI gets built.

### G11. Local HTTPS for dev (mkcert)

**Audience**: contributors hacking on this repo. Operators deploying
ctxlayer and end users of a deployed instance don't need mkcert —
Cloudflare's edge handles TLS for the public hostname.

The `__Host-` session cookie prefix requires `Secure`, which the
browser only honours over HTTPS. `wrangler dev` and `vite` both serve
HTTPS in dev, sharing a `mkcert`-generated cert in `.dev-tls/`
(gitignored).

- `scripts/setup-dev-tls.mjs` (idempotent, runs as `predev` on both
  worker and web). Checks `mkcert` is on PATH and prints install
  instructions if missing.
- `wrangler.toml` `[dev]` block: `local_protocol = "https"`,
  `https_key_path`/`https_cert_path` pointing into `.dev-tls/`.
- `apps/web/vite.config.ts`: reads the same cert + key into
  `server.https`; proxies use `target: 'https://localhost:8787'` with
  `secure: false` to trust the local CA.
- IdP redirect URIs in dev: `https://localhost:8787/idp/<idp>/callback`.
  Both Google and GitHub accept `localhost` as a valid redirect host.
- Prerequisite for new contributors: `brew install mkcert nss` (macOS)
  or the platform equivalent.

### G12. SPA session cookie shape

- Name: `__Host-ctx_session`. Attributes: `HttpOnly`, `Secure`,
  `SameSite=Lax`, `Path=/`, `Max-Age=2592000` (30d).
- Body: `<base64url(payload-json)>.<base64url(hmac-sha256)>`. Payload
  is `{ userId, role, iat, exp }` signed with
  `SESSION_COOKIE_SECRET` via WebCrypto.
- Verification is constant-time (`crypto.subtle.verify`).
- The OAuth redirect dance uses a sibling cookie
  `__Host-ctx_oauth_state` (TTL 10 min) carrying `{state, codeVerifier,
  returnTo, iat, exp}` so the callback can match state and exchange
  PKCE without server-side state storage.
- The MCP-client OAuth issuer (M2) will produce its own tokens via
  `workers-oauth-provider` — those tokens are independent of the SPA
  session cookie (separate lifecycles, separate signing keys).
