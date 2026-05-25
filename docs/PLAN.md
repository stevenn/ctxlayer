# ctxlayer — Agent Context Layer (MCP Service on Cloudflare)

## Status snapshot (2026-05-25)

| Milestone | Status | Demo / state |
|---|---|---|
| **M1** — Skeleton + sign-in | ✅ done | Live; Google/GitHub sign-in + allowlist |
| **M2** — Docs + RAG via MCP | ✅ done (May 2026) | Claude Web → `search_docs` against real Vectorize |
| **M3** — Realtime collab (Yjs) | ✅ done (May 2026) | Two-tab live edit on `:5173`, deployed to workers.dev |
| **M4** — Upstream proxy (HTTP/SSE + OAuth) | ✅ done (May 2026) | Claude Desktop → ctxlayer → Notion read + write via DCR/PKCE OAuth |
| **M5** — Admin polish (users, OAuth clients, audit) | ⏳ next | OAuth-flow + outbound proxy already shipped in M4; M5 trims to admin Users/OAuth/Audit pages + `shared_bearer` storage |
| **M6** — Usage pipeline + dashboards | 📋 planned | per-user/upstream charts |
| **Later** — Stdio upstreams via Daytona | 🅿️ parked | revisit when we have a real stdio upstream to serve |

- **Live**: `https://ctxlayer.stevenn-a65.workers.dev` — GitHub-only sign-in (`ALLOWED_GITHUB_USERS` + `ADMIN_EMAILS` gated).
- **Local dev**: `bun run dev` boots straight through. For sign-in / collab WS at `https://localhost:5173` (Vite HMR), also put `PUBLIC_BASE_URL=https://localhost:8787` in `.dev.vars` (the worker's Origin check has a localhost carve-out, but the IdP redirect URI is derived from PUBLIC_BASE_URL).
- **Validation entry point**: M3 prep notes (see [`docs/plan/M3-prep.md`](plan/M3-prep.md)) + M2 done-done checklist (see [Verification](#verification-plan)).

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
- Upstream transports: **Streamable HTTP / SSE natively** on Workers. Stdio via Daytona Cloud is designed (deep-dive [B](plan/B-daytona-stdio.md)) but **parked** — no real stdio upstream in scope yet.
- **Vectorize-backed RAG** for curated docs (chunked + embedded via Workers AI `@cf/baai/bge-base-en-v1.5`).
- Usage tracking: bytes + **approximate tokens via tiktoken** (WASM in the queue consumer).
- Editor: **BlockNote** (Notion-style, Tiptap-based, Yjs collab built in).
- Single Worker hosts both the API/MCP endpoints and the React SPA (Workers Assets).

**Why Daytona is the future-stdio plan (parked)**: Workers cannot spawn subprocesses (no `child_process` even with `nodejs_compat` — `workerd` is a V8-isolate sandbox without POSIX). When a real stdio MCP upstream lands, Daytona is the chosen offload — sub-90ms sandbox creation, TypeScript SDK callable from a Worker, public HTTP/WS proxy URLs, snapshot templates, auto-stop lifecycle. Until then we ship HTTP/SSE only and keep `apps/worker/src/upstream/daytona.ts` unwritten. The `stdio_daytona` transport literal in the `upstream_servers` CHECK constraint and the `sandbox_sessions` table are inert reservations from migration `0001`.

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
                                                                   v
                                                            Native HTTP/SSE
                                                            upstream MCP
                                                            servers
                                                            (Notion, Linear,
                                                             internal)

   (Future / parked) stdio upstreams would land via Daytona Cloud
   sandboxes per (user × upstream) with an in-sandbox stdio↔HTTP
   bridge — see docs/plan/B-daytona-stdio.md.
```

### Key flows
- **MCP tool call (HTTP/SSE upstream)** *(M4)*: agent → `/mcp` → OAuth-validated → `McpSessionDO` resolves namespace `notion__create_page` → lazy-connects `UpstreamClient` with decrypted user credentials → streams response → `waitUntil` enqueues a usage event.
- **MCP tool call (stdio upstream via Daytona)** *(parked — Later)*: agent → `/mcp` → resolves `github_stdio__create_issue` → `daytona.getOrCreateSandbox(...)` → sandbox runs stdio MCP server behind a stdio↔HTTP bridge → `UpstreamClient` opens HTTP → streams response → activity-refresh resets idle timer.
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
        upstream/http-client.ts                       †(M4 — Streamable HTTP / SSE)
        upstream/{daytona,sandbox-pool}.ts            †(Later — parked stdio plan)
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
  transport TEXT NOT NULL,                    -- 'streamable_http' | 'sse' (M4) | 'stdio_daytona' (parked)
  url TEXT,                                   -- NULL for stdio_daytona (resolved from sandbox)
  auth_strategy TEXT NOT NULL,                -- 'none'|'shared_bearer'|'user_bearer'|'user_oauth'
  auth_config TEXT NOT NULL,                  -- JSON; see below
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
-- M4 only writes rows with transport in ('streamable_http','sse').
-- The 'stdio_daytona' literal stays in the CHECK constraint for forward
-- compatibility; admin form validation rejects it until Daytona ships.
-- (Future) auth_config for stdio_daytona additionally carries:
--   { snapshotId, startCommand, bridgePort,
--     envTemplate: { "GITHUB_TOKEN": "${creds.access_token}", ... },
--     idleTimeoutSeconds, perUser: true }

-- sandbox_sessions: reserved table from 0001, no rows written until the
-- Daytona track ships. Plan: docs/plan/B-daytona-stdio.md.
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

### Dynamic proxied tools — ✅ M4
- For each enabled upstream where the caller has access via `upstream_visibility` AND is credentialed (or strategy is `none`), expose cached `upstream_tools` rows as `${slug}__${upstreamToolName}`. `__` in upstream tool names escapes to `_~_`. JSON-Schema → Zod conversion (`mcp/json-schema-to-zod.ts`) preserves descriptions + types so the SDK re-emits a faithful schema to MCP clients.

## Upstream proxy mechanics — ✅ M4 (HTTP/SSE shipped; Daytona stdio parked)

Shipped (full deep-dive in [docs/plan/C-upstream-proxy.md](plan/C-upstream-proxy.md)):
- Per-session `UpstreamProxyRegistry` (`apps/worker/src/mcp/tools-proxy.ts`) hydrates on `McpSessionDO.init()`; built-ins never force a connect.
- HTTP/SSE upstreams use `@modelcontextprotocol/sdk` Client directly via `apps/worker/src/upstream/http-client.ts`; bearer/OAuth creds decrypted just-in-time, 60s `AbortController` wall cap per tool call.
- `user_oauth` outbound: `apps/worker/src/upstream/oauth-provider.ts` implements MCP SDK's `OAuthClientProvider`. DCR client info → `upstream_servers.auth_config.oauth`, PKCE verifier + context → `OAUTH_KV`, sealed token bundle → `user_credentials` (kind=`oauth`). Routes at `apps/worker/src/api/upstream-oauth.ts`.
- Catalogue cache in `upstream_tools`; populates via post-OAuth `ctx.waitUntil` + session-init `ensureCatalogue` for stale rows. Admin "Refresh now" available for `none`-strategy upstreams.
- D1 BLOB normalization at the trust boundary in `db/queries/upstreams.getUserCredential` — D1 returns BLOBs in a shape SubtleCrypto rejects; we coerce to `Uint8Array` before handing to `aead.open`.
- Stdio upstreams via Daytona — designed in [docs/plan/B-daytona-stdio.md](plan/B-daytona-stdio.md) but **parked until a real stdio upstream is in scope**. The sandbox lifecycle / pool / nightly reconcile work all moves to that future track.

## Collaborative editor — ✅ M3 (shipped May 2026)

- **SPA**: `@blocknote/react` + `@blocknote/core` with the Yjs collab extension. ✅ Editor builds a per-doc `Y.Doc` + `CollabWSProvider` inside a StrictMode-safe effect; awareness-leader election (lowest clientID) decides which tab fires the REST autosave so concurrent tabs share one revision per ~5s debounce window. Connection status badge replaces the old dirty/Save UI.
- **Transport**: WebSocket to `/collab/:docId`. Pre-upgrade auth: session cookie + `getDocById` existence + same-origin via `util/origin.ts` (localhost carve-out for Vite HMR). CSRF intentionally not required on the upgrade — the DO never accepts state-changing HTTP, only WebSocket frames tagged read-only or read-write via per-socket attachment.
- **`DocRoomDO`**:
  - WebSocket Hibernation API (`acceptWebSocket` + `webSocketMessage` / `webSocketClose` / `webSocketError`).
  - Lazy-loads `docs/{id}/yjs/snapshot.bin` from R2 on construct / post-eviction wake; immediately sends `syncStep1` to every still-attached socket so peers re-send unflushed in-memory updates.
  - Broadcasts sync + awareness frames via `ctx.getWebSockets()`.
  - **Snapshot on every applied update**, coalesced through a single in-flight write (latest-wins) and held alive via `ctx.waitUntil`. The original "alarm-debounced flush" plan was wrong under hibernation — alarms fire on a fresh instance with stale R2 state. Details in [M3-prep.md D-M3.1 + D-M3.2](plan/M3-prep.md).
- **Reindex consumer** ✅ unchanged; SPA's debounced `PUT /api/docs/:id/content` keeps writing BlockNote JSON revisions that the existing consumer renders → embeds → upserts.
- **Storage**: `apps/worker/src/storage/docs-r2.ts` adds `readYjsSnapshot` / `writeYjsSnapshot`. Y.Doc bytes live alongside the JSON snapshot/revision tree; no rotation (one current binary snapshot only).

## Usage tracking — 📋 M6

- `McpSessionDO` wraps JSON-RPC dispatch with `onRequest`/`onResponse` middleware → `env.USAGE_QUEUE.send(...)` via `ctx.waitUntil`.
- Queue consumer (`usage-consumer.ts`, 📋 M6) batches 100, tokenizes via `js-tiktoken` (cl100k_base), inserts raw rows + upserts daily rollups.
- Tokens are documented as **approximate** — counts are heuristic for the prompt assembly the agent does on top of these payloads.
- Retention: `usage_events` 30 days (nightly cron prune); `usage_rollups_daily` retained indefinitely.

## Admin UI (`/app/admin/*`, role-gated)

- **Teams / Products / Team↔Product matrix** ✅ shipped (M2b/2).
- **Upstreams** ✅ shipped (M4) — list table + drawer with Details (slug locked, all other fields editable + enabled toggle + delete), Visibility (everyone / team checklist / product checklist), Tool-cache (count + last-refreshed + "Refresh now" for `none`-auth upstreams). `+ New upstream` modal. `shared_bearer` + `user_oauth` enabled; `stdio_daytona` rejected at form validation.
- **Users** 📋 M5 — table, promote/demote, revoke creds, inline team-membership.
- **Sandboxes** 🅿️ Later — live/idle/archived per user, force-destroy. Lands with the parked Daytona track, not M5.
- **Usage** 📋 M6 — charts + tables.
- **OAuth clients** 📋 M5 — DCR-registered MCP clients from `OAUTH_KV`.
- **Audit log** 📋 M5 — tail of `audit_log` rows.

## User UI

- `/sign-in` ✅ — GitHub (Google supported but disabled in this deploy).
- `/app/docs` ✅ — tree/list + BlockNote editor with Yjs realtime collab.
- `/app/admin/teams`, `/app/admin/products`, `/app/admin/upstreams` ✅.
- `/upstreams` ✅ shipped (M4) — cards per enabled upstream: `user_bearer` shows password-input + Connect/Replace/Disconnect; `user_oauth` shows Connect-with-OAuth button (DCR + PKCE round-trip happens here, before the agent session); `none`/`shared_bearer` show an info notice. `?oauth_connected=<slug>` / `?oauth_error=<...>` flash banner on return from the callback.
- `/mcp-setup` 📋 M5 — ctxlayer MCP URL + DCR instructions (currently the README covers this).
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
- **M3 — Realtime collab (1 wk)** ✅: `DocRoomDO` as a Yjs relay + per-update R2 binary snapshot (coalesced + `ctx.waitUntil`-held) over `/collab/:docId`; BlockNote wired with the Yjs collab extension via a custom 200-LoC `CollabWSProvider`; REST autosave triggers off Y.Doc updates with an awareness-leader election so concurrent tabs share one revision per ~5s debounce. Shared `util/origin.ts` Origin check (localhost carve-out) keeps Vite HMR at `:5173` viable for dev. Two pinned deviations from the original plan documented in [docs/plan/M3-prep.md](plan/M3-prep.md): @blocknote/server-util can't run in workerd (jsdom), and the alarm-debounced flush approach is wrong under WS Hibernation. Demo (closed May 2026): two browser tabs edit live, `doc_revisions` grows on leader-tab autosave, MCP `search_docs` reflects changes within seconds.
- **M4 — Upstream proxy: HTTP/SSE bearer + OAuth (shipped May 2026)** ✅:
  - `crypto/aead.ts` (AES-GCM seal/open keyed by `ENCRYPTION_KEY`, `key_version` ready for rotation).
  - `apps/worker/src/upstream/http-client.ts`: lazy `@modelcontextprotocol/sdk` Client per `(session, upstream)` for Streamable HTTP + SSE; decrypts `user_credentials` just-in-time; 60s `AbortController` wall cap; streams responses without buffering.
  - `apps/worker/src/mcp/{tools-proxy,tool-name,json-schema-to-zod}.ts`: aggregate `upstream_tools` rows into `tools/list` with `${slug}__${tool}` namespacing (escape `__` → `_~_`); JSON-Schema → Zod converter so the SDK emits a faithful schema back to the client; route `tools/call` by prefix; per-upstream error taxonomy minus the sandbox-specific codes.
  - `apps/worker/src/api/admin-upstreams.ts` + `apps/web/src/routes/admin/upstreams.tsx`: full admin REST + UI — list, create/edit drawer, visibility checklist (everyone/team/product), tool-cache view with refresh, delete. Slugs immutable. Form validation rejects `transport = 'stdio_daytona'`.
  - Catalogue cache: `client.listTools()` on first successful connect → write `upstream_tools`; session-start refresh inside `ensureCatalogue` for stale rows; post-credential-paste auto-warm via `ctx.waitUntil` so `toolsCount` populates immediately.
  - SPA `/upstreams`: cards per enabled upstream — `user_bearer` paste-token, `user_oauth` connect-with-OAuth button, `none`/`shared_bearer` info notice. `?oauth_connected=` / `?oauth_error=` banner round-trip from the callback.
  - **`user_oauth` flow (pulled forward from original M5 plan)**: `apps/worker/src/upstream/oauth-provider.ts` implements MCP SDK's `OAuthClientProvider` — DCR client info → `upstream_servers.auth_config.oauth`, PKCE verifier + flow context → `OAUTH_KV` (10 min TTL), sealed `{access_token, refresh_token, expires_at}` JSON → `user_credentials` with `kind='oauth'` (no migration). Routes: `GET /api/upstreams/:id/oauth/start` (per-user) → `auth()` → 302 to captured authorize URL or back to SPA when already AUTHORIZED; `GET /api/upstreams/oauth/callback` (global path, single redirect_uri per deployment) → state-keyed lookup → SDK exchange → catalogue warm.
  - Demo (closed May 2026): admin registers Notion via `/app/admin/upstreams` → user connects via OAuth on `/upstreams` (DCR + PKCE round-trip to `mcp.notion.com`) → Claude Desktop (via `mcp-remote`) calls `notion__notion-search`, `notion__notion-fetch`, `notion__notion-create-pages` end-to-end. 16 tools cached. Page successfully created in Notion through the proxy chain.
  - **Out of scope (parked until a real stdio upstream is needed)**: `apps/worker/src/upstream/{daytona,sandbox-pool}.ts`, `sandbox_sessions` writes, Daytona snapshot baking, env-var template substitution, idle-timeout reconcile cron, the admin Sandboxes pane. Recipe preserved in [B](plan/B-daytona-stdio.md).
  - **Deferred bits that slipped to M5**: `shared_bearer` storage (needs separate table or new columns; not blocking since Notion is `user_oauth`). Cosmetic: `mcp-remote`'s SSE-disconnect spam on idle (purely client-side; tool calls are POSTs and unaffected). Tool double-prefix when upstream names tools with their own prefix (e.g. `notion__notion-search`).
- **M5 — Admin polish + shared_bearer (1 wk)** 📋: admin Users page (promote/demote, revoke creds, team membership inline), admin OAuth clients page (DCR-registered MCP clients from `OAUTH_KV`), admin Audit log, `shared_bearer` credential storage (admin-set token used for all users on that upstream — new table or columns + admin form). *(Sandboxes admin pane moves to the parked Daytona track.)*
- **M6 — Usage pipeline + dashboards (1 wk)** 📋: usage queue + tiktoken consumer + rollups, admin usage dashboard, user usage page, cron prune. Demo: charts showing per-user/per-upstream calls + tokens.
- **Later — Stdio upstreams via Daytona** 🅿️: revive when a real stdio MCP upstream is on the roadmap. Picks up `apps/worker/src/upstream/{daytona,sandbox-pool}.ts`, the snapshot baking pipeline, env-var substitution, `sandbox_sessions` reconcile + nightly cron, Daytona-specific error codes (`-32002`/`-32003`), admin Sandboxes pane with force-destroy, and the `MAX_SANDBOXES_PER_USER` quota. Full recipe in [B](plan/B-daytona-stdio.md).

## Patterns to mirror from mcp-front (and what to skip)

**Reuse (patterns only — Go code is not reused):**
- Per-upstream `auth_strategy` field driving per-user vs shared credential handling.
- AES-GCM-at-rest for user credentials.
- Two-sided OAuth gateway (issuer to MCP clients, client to upstreams).
- RFC 8707 audience-scoped tokens (built into `workers-oauth-provider`).
- Org allowlist via IdP claims (Google `hd`, GitHub org membership).
- `slug__tool` namespacing across upstreams.

**Diverge:**
- Stdio transport — mcp-front spawns subprocesses directly; ctxlayer's plan is to offload to Daytona Cloud sandboxes per (user, upstream) with an in-sandbox stdio↔HTTP bridge (parked until a real stdio upstream is in scope).
- mcp-front's Go runtime and ELv2 licensing — pick our own license freely.

## Risks / known unknowns

- **MCP spec churn**: pin `@modelcontextprotocol/sdk` and `agents`; support both Streamable HTTP and SSE today; revisit when SSE fully deprecates.

**Parked (re-evaluate when the Daytona track is revived):**
- **Daytona cost scaling**: per-user × per-stdio-upstream active sandboxes. Mitigations: aggressive `idleTimeoutSeconds`, `MAX_SANDBOXES_PER_USER` quota enforced at provision time, admin UI showing live sandbox count + cost-per-day projection. Re-evaluate with real usage data.
- **Daytona vendor lock-in**: `apps/worker/src/upstream/daytona.ts` is intended as a single file with a narrow interface (`getOrReadySandbox`, `refreshActivity`, `destroy`, `list`) so swapping to E2B / Northflank / self-hosted Daytona later is a one-file change.
- **Daytona availability dependence**: if Daytona Cloud is down, stdio upstreams are down. HTTP upstreams remain unaffected. Surface in admin UI status panel; add a circuit breaker after N consecutive sandbox-create failures.
- **Sandbox snapshot drift**: stdio MCP servers update frequently; snapshots go stale. Build `bun run rebuild-snapshot:<slug>`, surface pinned package version in admin UI.
- **Credential exposure inside sandbox**: tokens flow as env vars into the container. Disable interactive shells on production snapshots; restrict `DAYTONA_API_KEY` scope; per-user sandboxes bound the blast radius.
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
- **M3** ✅ **CLOSED May 2026**: Two browser tabs on `/app/docs/:id` mirror keystrokes within ~100ms (Live badge green). Closing both tabs + reopening rehydrates from `docs/{id}/yjs/snapshot.bin` in R2. REST autosave fires once per ~5s debounce from the awareness-leader tab — `doc_revisions` grows monotonically with no double-rows per window. Read-only viewers (no `canEditDoc`) connect but writes are silently dropped. `search_docs` reflects edits within ~30s on the deployed worker. Local dev verified on `https://localhost:5173` (Vite HMR); production smoke-confirmed on workers.dev (incl. `/collab/:docId` returning 426 for non-WS GETs).
- **M4** ✅ **CLOSED May 2026**: Admin · Upstreams → register Notion (`https://mcp.notion.com/mcp`, transport `streamable_http`, auth `user_oauth`) → Visibility → Everyone signed in. User on `/upstreams` → **Connect with OAuth** → DCR + PKCE redirect to Notion → consent → back to `/upstreams?oauth_connected=notion`. Admin UI shows non-zero `toolsCount` after the auto-warm. Claude Desktop wired via `mcp-remote` shim (`NODE_EXTRA_CA_CERTS=$(mkcert -CAROOT)/rootCA.pem` for local-https trust): `list_upstreams` reports `connected: true, toolsCount: 16`; `notion__notion-search`, `notion__notion-fetch`, `notion__notion-create-pages` all return real data; page successfully created in Notion through the proxy. Sealed creds never logged. Visibility query correctly hides upstreams from users not in the granted team/product.
- **M5**: Admin · Users page CRUD smoke (promote/demote, revoke creds); admin OAuth clients listing reflects `OAUTH_KV` contents; admin Audit log shows recent role + credential mutations; `shared_bearer` upstream registers, admin pastes token, every user sees `connected: true` without per-user setup.
- **M6**: Drive synthetic load (script that opens MCP session + calls 100 tools), confirm `usage_events` populated and `usage_rollups_daily` reflects totals; verify tiktoken counts ≈ OpenAI tokenizer for spot-checked payloads.

## Deep-dive index

Topic-specific deep-dives live under [`docs/plan/`](plan/) so this file stays browsable:

- [A — Auth flows (inbound + outbound)](plan/A-auth-flows.md) — DCR, paste-bearer fallback, SPA session, allowlist enforcement, `user_bearer` / `user_oauth` / `shared_bearer` outbound, token & secret matrix.
- [B — Daytona stdio bridge](plan/B-daytona-stdio.md) 🅿️ *parked* — snapshot Dockerfile pattern, baking pipeline, env-var substitution, sandbox lifecycle, keep-alive, per-user vs pooled, fallback, cost projection. Revive when a real stdio MCP upstream is in scope.
- [C — Upstream proxy mechanics](plan/C-upstream-proxy.md) — `tools/list` aggregation, namespacing edge cases, lazy connect cost analysis, error taxonomy, streaming, subrequest accounting, concurrent calls, `list_upstreams()` shape.
- [D — UI surface + REST endpoints](plan/D-ui-and-rest.md) — sitemap, user screens, admin screens, role gating, full REST catalogue.
- [E — Dev environment](plan/E-dev-environment.md) — cloud-native session bootstrap, local dev DX, test harness, CI/CD, mobile/chat-driven workflow, module conventions, observability, env vars summary, onboarding checklist.
- [F — Org information architecture](plan/F-org-ia.md) — teams, products, upstream visibility, doc tags; data model additions in `0004_org_ia.sql`; access resolution; default search scope; built-in tools (`list_my_context`); admin UI + REST additions; UX guardrails.
- [G — Conventions captured by M1+M2 scaffolds](plan/G-conventions.md) — SQLite/D1 quirks, Workers Assets, DO migration rules (incl. M2-closure flat-collapse), Hono entry, Bun/Wrangler, SPA conventions, smoke + seed scripts, admin guardrails for M5, local HTTPS + cookie shape.
