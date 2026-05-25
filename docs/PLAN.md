# ctxlayer — Agent Context Layer (MCP Service on Cloudflare)

## Status snapshot (2026-05-25)

| Milestone | Status | Demo / state |
|---|---|---|
| **M1** — Skeleton + sign-in | ✅ done | Live; Google/GitHub sign-in + allowlist |
| **M2** — Docs + RAG via MCP | ✅ done (May 2026) | Claude Web → `search_docs` against real Vectorize |
| **M3** — Realtime collab (Yjs) | ⏳ next | (planned) two tabs editing live |
| **M4** — Upstream proxy (HTTP + Daytona stdio) | 📋 planned | Notion + GitHub via Claude |
| **M5** — OAuth upstreams + Admin UI | 📋 planned | Linear OAuth + admin smoke test |
| **M6** — Usage pipeline + dashboards | 📋 planned | per-user/upstream charts |

- **Live**: `https://ctxlayer.stevenn-a65.workers.dev` — GitHub-only sign-in (`ALLOWED_GITHUB_USERS` + `ADMIN_EMAILS` gated).
- **Local dev**: `bun run dev` boots straight through; put `PUBLIC_BASE_URL=https://localhost:8787` in `.dev.vars` to override the committed prod base.
- **Validation entry point**: M2 done-done checklist (see [Verification](#verification-plan)).

Deep-dive plans for each topic live in [`docs/plan/`](#deep-dive-index) so this file stays browsable.

## Context

Building **ctxlayer**, a remote MCP server that:

1. Serves a curated library of internal docs/specs (markdown, with RAG search via Vectorize) so every AI agent in the org sees the same baseline context.
2. Acts as an OAuth-fronted **proxy** to other MCP servers in the org (Notion, Linear, internal APIs, ...), centralising credential storage so users only authenticate once.
3. Provides a self-onboarding SPA where users sign in (Google Workspace or GitHub), connect upstream services, and collaboratively edit the curated docs in a visual markdown editor (BlockNote + Yjs).
4. Provides an admin UI for upstream configuration, user management, and per-user usage analytics (tool calls, bytes, approximate tokens via tiktoken).

**Locked-in choices** (from clarifying questions):
- Single-org per deployment (no multi-tenant complexity).
- Identity: **Google Workspace + GitHub** with org/domain allowlist.
- Upstream transports: **Streamable HTTP / SSE natively** on Workers, **stdio via Daytona Cloud** (a hosted container sandbox per user×upstream, with a stdio↔HTTP bridge inside).
- **Vectorize-backed RAG** for curated docs (chunked + embedded via Workers AI `@cf/baai/bge-base-en-v1.5`).
- Usage tracking: bytes + **approximate tokens via tiktoken** (WASM in the queue consumer).
- Editor: **BlockNote** (Notion-style, Tiptap-based, Yjs collab built in).
- Single Worker hosts both the API/MCP endpoints and the React SPA (Workers Assets).

**Why Daytona for stdio**: Workers cannot spawn subprocesses (no `child_process` even with `nodejs_compat` — `workerd` is a V8-isolate sandbox without POSIX). Stdio MCP servers need a real OS. Daytona offers sub-90ms sandbox creation, a TypeScript SDK callable from a Worker, public HTTP/WS proxy URLs with API-key auth at the proxy, snapshot templates so the server is pre-installed, and auto-stop/activity-refresh lifecycle.

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
                |  /idp/google,                                       |
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
- **MCP tool call (HTTP/SSE upstream)** *(M4)*: agent → `/mcp` → OAuth-validated → `McpSessionDO` resolves namespace `notion__create_page` → lazy-connects `UpstreamClient` with decrypted user credentials → streams response → `waitUntil` enqueues a usage event.
- **MCP tool call (stdio upstream via Daytona)** *(M4)*: agent → `/mcp` → resolves `github_stdio__create_issue` → `daytona.getOrCreateSandbox(...)` → sandbox runs stdio MCP server behind a stdio↔HTTP bridge → `UpstreamClient` opens HTTP → streams response → activity-refresh resets idle timer.
- **Doc edit** *(M3)*: SPA opens WebSocket to `/collab/:id` → `DocRoomDO` (one per doc) loads Y.Doc from R2 → BlockNote↔Yjs sync → debounced (5s idle / 30s max) snapshot to R2 + revision row in D1 + enqueue reindex.
- **Reindex** *(shipped)*: queue consumer renders blocks → markdown, chunks (~512 tokens, 64 overlap, heading-aware), embeds via Workers AI, upserts into Vectorize keyed `${docId}:${chunkIdx}`. Orphan cleanup via `chunk_count` tracking when revisions shrink.

## Directory layout

Bun workspace, single deployable Worker, SPA shipped via Workers Assets.
Forward-looking — some paths land with later milestones (marked †).

```
ctxlayer/
  wrangler.toml
  package.json  bunfig.toml  tsconfig.base.json
  apps/
    worker/
      src/
        index.ts                # Hono app, mounts OAuthProvider + routes
        env.ts                  # Env binding types
        api/{auth,me,config,docs,doc-tags,doc-sharing,teams,users,
             admin-teams,admin-products,health,version}.ts
        idp/{google,github,common,complete-mcp}.ts
        oauth/authorize-page.ts
        mcp/session-do.ts       # McpAgent + built-in tools
        mcp/{tools-proxy,upstream-client}.ts          †(M4)
        upstream/{daytona,sandbox-pool}.ts            †(M4)
        collab/{doc-room-do,yjs-persistence}.ts       †(M3 — currently 501 stub)
        queues/reindex-consumer.ts
        queues/usage-consumer.ts                      †(M6)
        crypto/aead.ts                                †(M4 — needed for user_credentials)
        rag/{markdown,chunker,embedder,index}.ts
        db/{client,migrations/*.sql,queries/*}.ts
        util/...
    web/
      src/
        routes/{sign-in,docs-list,docs-editor,docs-sharing,
                upstreams,mcp-setup,usage}.tsx
        routes/admin/{index,teams,products,stubs}.tsx
        components/{editor,charts}/                   # charts †(M6)
        lib/{api,csrf,...}.ts
  packages/
    shared/src/...                                    # types shared worker↔SPA
```

## Data model (D1)

The tables below cover the core MCP / docs / usage surfaces. The
**org information architecture** (teams, products, upstream visibility,
doc tags) is additive and lives in migration `0004_org_ia.sql` — see
**[docs/plan/F-org-ia.md](plan/F-org-ia.md)** for the schema and
access-resolution semantics.

**Applied migrations**: `0001_init` → `0006_doc_chunk_count` (all live on remote D1).

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

-- 0004_org_ia.sql       see docs/plan/F-org-ia.md
-- 0005_doc_acl.sql      per-document write ACL (M2a)
-- 0006_doc_chunk_count.sql  documents.chunk_count for orphan-vector cleanup
```

OAuth provider state (inbound clients/tokens) is fully managed by `workers-oauth-provider` in KV — no D1 mirror needed unless the admin UI wants to read it directly.

## Auth model

See [docs/plan/A-auth-flows.md](plan/A-auth-flows.md) for full flow diagrams (inbound DCR, paste-bearer fallback, SPA session, allowlist enforcement, outbound `user_bearer` / `user_oauth` / `shared_bearer`).

**Inbound (MCP client → ctxlayer)** — `@cloudflare/workers-oauth-provider` mounts at `/oauth/*` + `/.well-known/oauth-authorization-server`. Allowlist enforced in IdP callback: Google `hd` claim or email allowlist; GitHub org membership or login allowlist. `props = {userId, email, name, role}` rides with the access token into `McpSessionDO`.

**Outbound (ctxlayer → upstream MCP)** *(M4+)* — strategies per upstream: `none` / `shared_bearer` / `user_bearer` / `user_oauth`. All sensitive material AES-GCM sealed via `crypto/aead.ts` (M4).

**Admin gating** — `users.role` (`'user' | 'admin'`). Bootstrap via `ADMIN_EMAILS` env (auto-promote on first sign-in). Every `/api/admin/*` checks `props.role === 'admin'` server-side.

## MCP server surface

### Built-in tools — **shipped (M2c)**
- `whoami()` — `{userId, email, role}`.
- `list_my_context()` — `{teams, products, accessibleUpstreams, defaultScope}`.
- `list_upstreams()` — `[{slug, displayName, connected}]`, already scoped by `upstream_visibility`.
- `get_doc({ id })` — rendered markdown.
- `search_docs({ query, k?, scope? })` — Vectorize query; `scope` defaults to caller's teams/products, pass `'all'` to disable. See [F](plan/F-org-ia.md) for scope semantics.

### Resources & prompts — **partial**
- Each non-deleted document is published as `mcp://ctxlayer/docs/{id}` (`text/markdown`). ✅
- Prompt-kind documents via `prompts/list` — 📋 planned (M5 polish).

### Dynamic proxied tools — **📋 M4**
- For each enabled upstream where the caller has access via `upstream_visibility` AND is credentialed (or strategy is `none`/`shared_bearer`), expose cached `upstream_tools` rows as `${slug}__${upstreamToolName}`. `__` in upstream tool names escapes to `_~_`.

## Upstream proxy mechanics — 📋 M4

Headline plan (full deep-dive in [docs/plan/C-upstream-proxy.md](plan/C-upstream-proxy.md)):
- Lazy connect via `McpSessionDO`'s upstream-client map; built-ins never force a connect.
- HTTP/SSE upstreams use `@modelcontextprotocol/sdk` Client directly.
- Stdio upstreams pass through Daytona sandboxes (see [docs/plan/B-daytona-stdio.md](plan/B-daytona-stdio.md)) — credentials injected as sandbox env vars, not HTTP headers.
- Sandbox lifecycle: configurable `idleTimeoutSeconds` (default 600), nightly reconcile via `sandbox_sessions`, admin force-destroy.

## Collaborative editor — ⏳ M3

- **SPA**: `@blocknote/react` + `@blocknote/core` with the Yjs collab extension. ✅ editor wired (REST autosave today).
- **Transport** *(M3)*: WebSocket to `/collab/:id`, session cookie + CSRF ticket verified before `upgrade`.
- **`DocRoomDO`** *(M3 — currently 501 stub)*:
  - WebSocket Hibernation API (`webSocketMessage`, `webSocketClose`).
  - Lazy-loads `docs/{id}/snapshot.bin` from R2 on first wake.
  - Broadcasts sync/awareness frames via `ctx.getWebSockets()`.
  - Debounced flush (5s idle / 30s max) + final flush via `setAlarm` when room empties.
  - Flush writes snapshot, rotates `revisions/{ts}.bin`, inserts `doc_revisions` row, enqueues `{docId, revisionId}` to `DOC_REINDEX_QUEUE`.
- **Reindex consumer** ✅ already wired; M3 keeps it on BlockNote JSON (driven by the SPA's debounced REST autosave). See [M3-prep.md D-M3.1](plan/M3-prep.md#d-m31--blocknoteserver-util-is-not-viable-in-workerd).

## Usage tracking — 📋 M6

- `McpSessionDO` wraps JSON-RPC dispatch with `onRequest`/`onResponse` middleware → `env.USAGE_QUEUE.send(...)` via `ctx.waitUntil`.
- Queue consumer (`usage-consumer.ts`, 📋 M6) batches 100, tokenizes via `js-tiktoken` (cl100k_base), inserts raw rows + upserts daily rollups.
- Tokens are documented as **approximate** — counts are heuristic for the prompt assembly the agent does on top of these payloads.
- Retention: `usage_events` 30 days (nightly cron prune); `usage_rollups_daily` retained indefinitely.

## Admin UI (`/app/admin/*`, role-gated)

- **Teams / Products / Team↔Product matrix** ✅ shipped (M2b/2).
- **Upstreams** 📋 M5 — CRUD + edit modal, "Test connection" + "Refresh tool cache" buttons, visibility section per [F](plan/F-org-ia.md).
- **Users** 📋 M5 — table, promote/demote, revoke creds, inline team-membership.
- **Sandboxes** 📋 M5 — live/idle/archived per user, force-destroy.
- **Usage** 📋 M6 — charts + tables.
- **OAuth clients** 📋 M5 — DCR-registered MCP clients from `OAUTH_KV`.
- **Audit log** 📋 M5 — tail of `audit_log` rows.

## User UI

- `/sign-in` ✅ — GitHub (Google supported but disabled in this deploy).
- `/app/docs` ✅ — tree/list + BlockNote editor (REST autosave today, Yjs in M3).
- `/app/admin/teams`, `/app/admin/products` ✅.
- `/upstreams` 📋 M4 — cards per enabled upstream with auth-strategy-appropriate control. Crucial UX note: all `user_oauth` connections happen here in the SPA, *before* the agent session, so Claude/Cursor never need to host a browser flow.
- `/mcp-setup` 📋 M4/M5 — ctxlayer MCP URL + DCR instructions.
- `/usage` 📋 M6 — personal stats.

## Deployment / configuration

The live `wrangler.toml`, bootstrap script, and migrations are the source of truth — see [`wrangler.toml`](../wrangler.toml) + [`scripts/bootstrap-resources.mjs`](../scripts/bootstrap-resources.mjs). Highlights:

- Single Worker (`name = "ctxlayer"`), Workers Assets ships the SPA from `apps/web/dist`.
- Bindings: D1 (`DB`), KV (`OAUTH_KV`), R2 (`DOCS_BUCKET`), Vectorize (`DOCS_INDEX`), AI, two DOs (`McpSessionDO` SQLite-backed, `DocRoomDO` non-SQLite until M3), two queues (`USAGE_QUEUE`, `DOC_REINDEX_QUEUE`).
- DO migrations collapsed to a single tag (`new_classes = ["DocRoomDO"]` + `new_sqlite_classes = ["McpSessionDO"]`) — CF's validator rejects per-tag delete+create on a fresh account (codes 10021/10074). See [docs/plan/G-conventions.md](plan/G-conventions.md) G3 for the gotchas this avoids.
- Nightly cron `0 3 * * *` reserved for usage pruning + upstream tool-cache refresh (M6).

`bun run dev` provisions local HTTPS via mkcert (`.dev-tls/`) on first run; the `__Host-ctx_session` cookie requires `Secure` so HTTPS is mandatory even locally. See [docs/plan/G-conventions.md](plan/G-conventions.md) G11–G12 for cookie + cert details.

## Milestone breakdown

Each milestone is independently deployable and demoable.

- **M1 — Skeleton (1 wk)** ✅: Bun workspace, Vite SPA shell, `wrangler.toml` with all bindings, D1 migrations `0001`–`0004`, Google/GitHub sign-in with allowlist, `/api/me`, `/api/config`. Demo (closed): sign in, see your email.
- **M2 — Docs + RAG (1.5 wk)** ✅: BlockNote editor with REST save, R2 storage, `documents`/`doc_revisions`, reindex queue + Vectorize + Workers AI, `McpAgent` mounted at `/mcp`+`/sse`, `workers-oauth-provider` wired, built-in tools `search_docs`/`get_doc`/`whoami`/`list_my_context`/`list_upstreams`, doc resources, doc tags + admin teams/products, chunk_count orphan cleanup. Demo (closed May 2026): Claude Web searches internal docs via MCP against real Vectorize.
- **M3 — Realtime collab (1 wk)** ⏳: `DocRoomDO` as a Yjs relay + binary snapshot over `/collab/:docId`; BlockNote gets the Yjs collab extension; existing REST autosave triggers off Y.Doc updates with an awareness-leader election so concurrent tabs share one revision per debounce window. Demo: two browser tabs edit live; MCP search reflects changes within seconds. Slice plan + the two pinned deviations: [docs/plan/M3-prep.md](plan/M3-prep.md).
- **M4 — Upstream proxy: bearer + stdio via Daytona (3 wk)** 📋: `upstream_servers` + `sandbox_sessions` admin REST (no UI yet), `user_credentials` + AES-GCM crypto, `UpstreamClient` lazy connect + catalogue cache, dynamic tool aggregation + proxy routing, `apps/worker/src/upstream/daytona.ts` wrapping `@daytonaio/sdk`, one pre-baked Daytona snapshot for a reference stdio MCP server, env-var template substitution from `user_credentials`, SPA `/upstreams` for `user_bearer` strategy. Demo: (a) Notion HTTP MCP — paste token, agent calls `notion__search_pages`; (b) GitHub stdio MCP — paste PAT, agent calls `github_stdio__create_issue`; sandbox auto-stops after 10min idle. Detailed plans: [C](plan/C-upstream-proxy.md) + [B](plan/B-daytona-stdio.md).
- **M5 — OAuth upstreams + Admin UI (2 wk)** 📋: `user_oauth` start/callback/refresh, admin UI (upstreams CRUD incl. snapshot/start-command editor, users, OAuth clients, audit log, sandboxes view with force-destroy), role promotion. Demo: Linear added via OAuth; admin manages everything from UI including killing a runaway sandbox.
- **M6 — Usage pipeline + dashboards (1 wk)** 📋: usage queue + tiktoken consumer + rollups, admin usage dashboard, user usage page, cron prune. Demo: charts showing per-user/per-upstream calls + tokens.

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

- **Daytona cost scaling**: per-user × per-stdio-upstream active sandboxes. Mitigations: aggressive `idleTimeoutSeconds`, `MAX_SANDBOXES_PER_USER` quota enforced at provision time, admin UI showing live sandbox count + cost-per-day projection. Re-evaluate at M6 with real usage data.
- **Daytona vendor lock-in**: `apps/worker/src/upstream/daytona.ts` is a single file with a narrow interface (`getOrReadySandbox`, `refreshActivity`, `destroy`, `list`) so swapping to E2B / Northflank / self-hosted Daytona later is a one-file change.
- **Daytona availability dependence**: if Daytona Cloud is down, stdio upstreams are down. HTTP upstreams remain unaffected. Surface in admin UI status panel; add a circuit breaker after N consecutive sandbox-create failures.
- **Sandbox snapshot drift**: stdio MCP servers update frequently; snapshots go stale. Build `bun run rebuild-snapshot:<slug>`, surface pinned package version in admin UI.
- **Credential exposure inside sandbox**: tokens flow as env vars into the container. Disable interactive shells on production snapshots; restrict `DAYTONA_API_KEY` scope; per-user sandboxes bound the blast radius.
- **MCP spec churn**: pin `@modelcontextprotocol/sdk` and `agents`; support both Streamable HTTP and SSE today; revisit when SSE fully deprecates.
- **OAuth UX from inside the agent**: handled by doing all `user_oauth` connection in the SPA before the agent session — flag prominently in `/mcp-setup`.
- **Vectorize cost/limits**: 5M vectors/index is plenty for org-scale corpora; cache `search_docs` results in KV by query hash if it becomes hot.
- **Workers CPU/wall limits**: streaming responses avoid CPU pressure; enforce 60s wall cap on a single upstream call.
- **D1 write QPS** on `usage_events`: queue batching is the safety valve; shardable by user-id prefix later if needed.
- **Workers Assets vs API route shadowing**: be explicit with `run_worker_first` patterns.

## Verification plan

- **M1** ✅: `wrangler deploy`, open URL, sign in via the configured IdP, confirm allowlist rejection works for outside-domain users.
- **M2** ✅ **CLOSED May 2026**: Claude (Web + Desktop) connects as a remote MCP server; `search_docs`, `get_doc`, `whoami`, `list_my_context` all return real data against real Vectorize. Orphan-vector cleanup verified by shrink test.

  Done-done checklist (validated, in order). `wrangler dev --remote` is NOT a viable shortcut — it can't host the reindex queue consumer or SQLite-backed Durable Objects, so the RAG pipeline can't complete there. Go straight to deploy.
  1. `wrangler login` (or set `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`).
  2. `bun run bootstrap` — provisions D1, KV, R2, Vectorize, and both queues (`ctxlayer-usage`, `ctxlayer-reindex`); patches `wrangler.toml` with the IDs. Idempotent.
  3. `bun run migrate:remote` — applies migrations `0001`–`0006` to the real D1.
  4. Set remote secrets — one `wrangler secret put <NAME>` per: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `ENCRYPTION_KEY` (32 random bytes b64), `SESSION_COOKIE_SECRET` (random 32+ bytes), `ALLOWED_GITHUB_USERS` (or `ALLOWED_GOOGLE_EMAILS`), `ADMIN_EMAILS`. Same values as `.dev.vars` locally — that file is local-only. `ALLOWED_*` and `ADMIN_EMAILS` are intentionally NOT declared in `[vars]` (declaring them would block `wrangler secret put` with code 10053).
  5. `bun run seed:remote` — seeds 3 teams + 2 products so the tag pane isn't empty.
  6. First `bun run deploy` — registers the worker and prints `https://ctxlayer.<subdomain>.workers.dev`. Patch `[vars] PUBLIC_BASE_URL` to this URL, swap each IdP's redirect URI (GitHub OAuth apps allow only one — swap rather than add), `bun run deploy` again. For local dev to keep working with the workers.dev base committed, put `PUBLIC_BASE_URL=https://localhost:8787` in `.dev.vars` to override `[vars]`.
  7. Sign in via the deployed SPA. Confirm `/api/me` returns 200 and `__Host-ctx_session` + `__Host-ctx_csrf` cookies are set.
  8. Create a doc, type real content, save. Tag it with at least one team via the right-rail tag pane.
  9. `bun run logs:all` to tail. Saving a doc enqueues `{docId, revisionId}` → consumer renders → embeds → upserts. Queue batches every 30s.
  10. Sanity: `wrangler vectorize get-vectors ctxlayer-docs --ids <docId>:0` returns the chunk + metadata; `wrangler vectorize list-vectors ctxlayer-docs --count 100` shows the full set.
  11. Wire Claude (Web or Desktop): `{"mcpServers": {"ctxlayer": {"url": "https://<URL>/mcp"}}}`. For Claude Web that's claude.ai → Settings → Connectors → Add custom. Claude triggers DCR + `/oauth/authorize` → IdP chooser → back.
  12. In Claude: `whoami`, `list_my_context`, `get_doc({id: ...})`, `search_docs({query: "..."})` — all return real data. Note: admin role doesn't grant team membership; use `scope: "all"`, or add yourself to a team via `/app/admin/teams`.
  13. Shrink the doc; next reindex deletes the orphan vectors via `chunk_count` tracking (migration `0006`); `list-vectors` drops to the new count with no stragglers above.
- **M3**: Two browser tabs editing concurrently; kill DO via `wrangler tail`, confirm WS reconnect + snapshot reload; verify revisions in D1.
- **M4**: (a) Add Notion HTTP upstream via D1 insert; paste PAT in SPA; from Claude call `notion__search_pages`; verify decrypted creds never leave the Worker (check logs). (b) Pre-build a Daytona snapshot containing `@modelcontextprotocol/server-github` + `supergateway`; register as `stdio_daytona` upstream; from Claude call `github_stdio__create_issue`; observe sandbox in Daytona dashboard; wait 10min; confirm auto-stop; call again, confirm wake works.
- **M5**: Walk OAuth flow end-to-end for Linear; force token expiry by editing `expires_at`, confirm auto-refresh; admin UI smoke-test all CRUD operations.
- **M6**: Drive synthetic load (script that opens MCP session + calls 100 tools), confirm `usage_events` populated and `usage_rollups_daily` reflects totals; verify tiktoken counts ≈ OpenAI tokenizer for spot-checked payloads.

## Deep-dive index

Topic-specific deep-dives live under [`docs/plan/`](plan/) so this file stays browsable:

- [A — Auth flows (inbound + outbound)](plan/A-auth-flows.md) — DCR, paste-bearer fallback, SPA session, allowlist enforcement, `user_bearer` / `user_oauth` / `shared_bearer` outbound, token & secret matrix.
- [B — Daytona stdio bridge](plan/B-daytona-stdio.md) — snapshot Dockerfile pattern, baking pipeline, env-var substitution, sandbox lifecycle, keep-alive, per-user vs pooled, fallback, cost projection.
- [C — Upstream proxy mechanics](plan/C-upstream-proxy.md) — `tools/list` aggregation, namespacing edge cases, lazy connect cost analysis, error taxonomy, streaming, subrequest accounting, concurrent calls, `list_upstreams()` shape.
- [D — UI surface + REST endpoints](plan/D-ui-and-rest.md) — sitemap, user screens, admin screens, role gating, full REST catalogue.
- [E — Dev environment](plan/E-dev-environment.md) — cloud-native session bootstrap, local dev DX, test harness, CI/CD, mobile/chat-driven workflow, module conventions, observability, env vars summary, onboarding checklist.
- [F — Org information architecture](plan/F-org-ia.md) — teams, products, upstream visibility, doc tags; data model additions in `0004_org_ia.sql`; access resolution; default search scope; built-in tools (`list_my_context`); admin UI + REST additions; UX guardrails.
- [G — Conventions captured by M1+M2 scaffolds](plan/G-conventions.md) — SQLite/D1 quirks, Workers Assets, DO migration rules (incl. M2-closure flat-collapse), Hono entry, Bun/Wrangler, SPA conventions, smoke + seed scripts, admin guardrails for M5, local HTTPS + cookie shape.
