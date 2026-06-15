# ctxlayer — Agent Context Layer (MCP Service on Cloudflare)

_Architecture & data-model reference. The milestone-driven plan that built
ctxlayer through M1–M8 is retired (May 2026); this file is the durable
reference, not a roadmap. New work proceeds ad hoc — track it in code,
commits, and `CLAUDE.md`, not here. Topic deep-dives live under
[`docs/plan/`](#deep-dive-index)._

## Context

**ctxlayer** is a remote MCP server that:

1. Serves a curated library of internal docs/specs (markdown, with RAG search via Vectorize) so every AI agent in the org sees the same baseline context. The library interops with the [Open Knowledge Format (OKF)](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) — import, export, and git-write-back of YAML-frontmatter Markdown — see deep-dive [M](plan/M-okf.md).
2. Acts as an OAuth-fronted **proxy** to other MCP servers in the org (Notion, Linear, internal APIs, ...), centralising credential storage so users only authenticate once.
3. Provides a self-onboarding SPA where users sign in (Google Workspace or GitHub), connect upstream services, and collaboratively edit the curated docs in a visual markdown editor (BlockNote + Yjs).
4. Provides an admin UI for upstream configuration, user management, and per-user usage analytics (tool calls, bytes, approximate tokens via tiktoken).

**Locked-in choices**:
- Single-org per deployment (no multi-tenant complexity).
- Identity: **Google Workspace + GitHub** with org/domain allowlist.
- Upstream transports: **Streamable HTTP / SSE natively** on Workers. A stdio MCP server is supported via **bring-your-own-bridge** — the operator fronts it with their own stdio↔HTTP bridge and registers the HTTP URL as a `streamable_http` upstream (deep-dive [B](plan/B-stdio-bridge.md)). ctxlayer runs no sandboxes.
- **Vectorize-backed RAG** for curated docs (chunked + embedded via Workers AI `@cf/baai/bge-base-en-v1.5`).
- Usage tracking: bytes + **approximate tokens via tiktoken** (WASM in the queue consumer).
- Editor: **BlockNote** (Notion-style, Tiptap-based, Yjs collab built in).
- Single Worker hosts both the API/MCP endpoints and the React SPA (Workers Assets).

**Why stdio is bring-your-own-bridge**: Workers cannot spawn subprocesses (no `child_process` even with `nodejs_compat` — `workerd` is a V8 isolate without POSIX), so ctxlayer never hosts a stdio MCP server itself. Instead the operator runs their own stdio↔HTTP bridge (e.g. `supergateway`) on infrastructure they control and registers its HTTPS URL as an ordinary `streamable_http` upstream; per-user creds use the existing `user_bearer` / `user_oauth` strategies. The proxy is built around a generic `UpstreamClient` interface so future transports can slot in. See deep-dive [B](plan/B-stdio-bridge.md).

**Inspiration**: [stainless-api/mcp-front](https://github.com/stainless-api/mcp-front). Reused patterns (per-service auth strategies, encrypted creds at rest, audience-scoped tokens, OAuth gateway); no code reuse (Go, ELv2-licensed). The Worker never spawns processes, so stdio diverges to bring-your-own-bridge.

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

   Stdio upstreams: the operator runs their own stdio↔HTTP bridge
   (e.g. supergateway) and registers its HTTPS URL as a normal
   streamable_http upstream — see docs/plan/B-stdio-bridge.md.
```

### Key flows
- **MCP tool call (HTTP/SSE upstream)**: agent → `/mcp` → OAuth-validated → `McpSessionDO` resolves namespace `notion__create_page` → lazy-connects `UpstreamClient` with decrypted user credentials → streams response → **stages a usage event in the DO's SQLite outbox** (`usage/outbox.ts`); an idempotent `flushUsageOutbox` alarm drains it to `USAGE_QUEUE`. (Replaced the old per-call `ctx.waitUntil(queue.send)`, whose background send was cancelled once the streaming response ended — the "waitUntil() tasks did not complete" warning — silently dropping usage rows.)
- **MCP tool call (stdio upstream via bring-your-own-bridge)**: agent → `/mcp` → resolves `github_stdio__create_issue` → `UpstreamClient` opens HTTP to the operator-run bridge's `streamable_http` URL → streams response → stages a usage event in the DO outbox (drained on alarm, as above). ctxlayer treats it like any HTTP upstream.
- **Doc edit**: SPA opens WebSocket to `/collab/:id` → `DocRoomDO` (one per doc) loads Y.Doc from R2 → BlockNote↔Yjs sync → debounced (3s idle / 30s max) snapshot to R2 + revision row in D1 + enqueue reindex.
- **Reindex**: queue consumer renders blocks → markdown, chunks (~512 tokens, 64 overlap, heading-aware), embeds via Workers AI, upserts into Vectorize keyed `${docId}:${chunkIdx}`. Orphan cleanup via `chunk_count` tracking when revisions shrink.

## Directory layout

Bun workspace, single deployable Worker, SPA shipped via Workers Assets.
Illustrative — read the tree on disk for the current shape.

```
ctxlayer/
  wrangler.toml
  package.json  bunfig.toml  tsconfig.base.json
  apps/
    worker/
      src/
        index.ts                # OAuthProvider + HSTS/queue/scheduled wrapper
        app.ts                  # Hono app, mounts all routes
        env.ts                  # Env binding types
        api/{auth,me,config,docs,doc-tags,doc-sharing,teams,users,
             admin-teams,admin-products,health,version,...}.ts
        idp/{google,github,common,complete-mcp}.ts
        oauth/{authorize-page,provider-config}.ts
        mcp/session-do.ts       # McpAgent + built-in tools + usage outbox
        mcp/{tools-proxy,tool-name,json-schema-to-zod,skill-mcp}.ts
        upstream/{http-client,oauth-provider,upstream-client,bearer}.ts
        collab/{doc-room-do,upgrade}.ts
        queues/{reindex-consumer,usage-consumer}.ts
        usage/{event,tokens,record,outbox}.ts   # outbox = DO-staged, alarm-drained
        crypto/aead.ts
        rag/{markdown,chunker,embedder,index}.ts
        db/{client,migrations/*.sql,queries/*}.ts
        util/...
    web/
      src/
        routes/{sign-in,docs-list,docs-editor,docs-sharing,
                upstreams,mcp-setup,usage}.tsx
        routes/admin/{index,teams,products,users,upstreams,
                      audit,oauth-clients,usage}.tsx
        components/{editor,usage}/                    # SVG usage charts (no chart-lib dep)
        lib/{api,csrf,...}.ts
  packages/
    shared/src/...                                    # types shared worker↔SPA
```

## Data model (D1)

The canonical migration set is **`apps/worker/src/db/migrations/*.sql`** — read
those for the current shape. The SQL below documents the original core tables
(`0001`–`0006`); later migrations add `shared_bearer` creds, per-doc ACL /
folders / locks, the org-IA tables (`0004`, see
**[docs/plan/F-org-ia.md](plan/F-org-ia.md)**), skills + attachments, and
usage-resilience columns (`0014`).

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
  transport TEXT NOT NULL,                    -- 'streamable_http' | 'sse'
  url TEXT,                                   -- upstream MCP endpoint (HTTPS)
  auth_strategy TEXT NOT NULL,                -- 'none'|'shared_bearer'|'user_bearer'|'user_oauth'
  auth_config TEXT NOT NULL,                  -- JSON; timeouts + maxResponseBytes + oauth DCR info
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
-- Transport is one of ('streamable_http','sse'). A stdio MCP server is
-- reached by registering an operator-run stdio↔HTTP bridge as a normal
-- 'streamable_http' upstream — see docs/plan/B-stdio-bridge.md. The old
-- vendor-specific stdio transport literal and the unused sandbox-sessions
-- table are dropped by migration 0013.

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

-- 0003_usage.sql  (0014 adds truncated/timeouts/truncations columns)
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
-- 0005_doc_acl.sql      per-document write ACL
-- 0006_doc_chunk_count.sql  documents.chunk_count for orphan-vector cleanup
```

OAuth provider state (inbound clients/tokens) is fully managed by `workers-oauth-provider` in KV — no D1 mirror needed unless the admin UI wants to read it directly.

## Auth model

See [docs/plan/A-auth-flows.md](plan/A-auth-flows.md) for full flow diagrams (inbound DCR, paste-bearer fallback, SPA session, allowlist enforcement, outbound `user_bearer` / `user_oauth` / `shared_bearer`).

**Inbound (MCP client → ctxlayer)** — `@cloudflare/workers-oauth-provider` mounts at `/oauth/*` + `/.well-known/oauth-authorization-server`. Allowlist enforced in IdP callback: Google `hd` claim or email allowlist; GitHub org membership or login allowlist. `props = {userId, email, name, role}` rides with the access token into `McpSessionDO`.

**Outbound (ctxlayer → upstream MCP)** — strategies per upstream: `none` / `shared_bearer` / `user_bearer` / `user_oauth`. All sensitive material AES-GCM sealed via `crypto/aead.ts`.

**Admin gating** — `users.role` (`'user' | 'admin'`). Bootstrap via `ADMIN_EMAILS` env (auto-promote on first sign-in). Every `/api/admin/*` checks `props.role === 'admin'` server-side.

## MCP server surface

### Built-in tools
- `whoami()` — `{userId, email, role}`.
- `list_my_context()` — `{teams, products, accessibleUpstreams, defaultScope}`.
- `list_upstreams()` — `[{slug, displayName, connected}]`, already scoped by `upstream_visibility`.
- `get_doc({ id })` — rendered markdown.
- `search_docs({ query, k?, scope? })` — Vectorize query; `scope` defaults to caller's teams/products, pass `'all'` to disable. See [F](plan/F-org-ia.md) for scope semantics.
- `list_skills()` / `get_skill({ slug })` — org-curated procedural playbooks (skills surface), with attachment metadata on upstreams.

### Resources & prompts
- Each non-deleted document is published as `mcp://ctxlayer/docs/{id}` (`text/markdown`); skills as `mcp://ctxlayer/skills/{slug}`.
- Prompt-kind documents via `prompts/list` — **on-demand only** (the doc model accepts `kind='prompt'`; the MCP wiring is unwritten). Revisit when a doc author actually requests prompt-kind authoring.

### Dynamic proxied tools
- For each enabled upstream where the caller has access via `upstream_visibility` AND is credentialed (or strategy is `none`), expose cached `upstream_tools` rows as `${slug}__${upstreamToolName}`. `__` in upstream tool names escapes to `_~_`. JSON-Schema → Zod conversion (`mcp/json-schema-to-zod.ts`) preserves descriptions + types so the SDK re-emits a faithful schema to MCP clients.

## Upstream proxy mechanics

Full deep-dive in [docs/plan/C-upstream-proxy.md](plan/C-upstream-proxy.md);
resilience (long calls + oversized responses) in [docs/plan/I-upstream-resilience.md](plan/I-upstream-resilience.md).

- Per-session `UpstreamProxyRegistry` (`apps/worker/src/mcp/tools-proxy.ts`) hydrates on `McpSessionDO.init()`; built-ins never force a connect.
- HTTP/SSE upstreams use `@modelcontextprotocol/sdk` Client directly via `apps/worker/src/upstream/http-client.ts`; bearer/OAuth creds decrypted just-in-time; per-call timeout is 150s base inactivity / 300s hard ceiling, per-upstream overridable via `authConfig.timeouts`, plus a 256 KB default response-size cap overridable via `authConfig.maxResponseBytes`.
- `user_oauth` outbound: `apps/worker/src/upstream/oauth-provider.ts` implements MCP SDK's `OAuthClientProvider`. DCR client info → `upstream_servers.auth_config.oauth`, PKCE verifier + context → `OAUTH_KV`, sealed token bundle → `user_credentials` (kind=`oauth`). Routes at `apps/worker/src/api/upstream-oauth.ts`.
- Catalogue cache in `upstream_tools`; populates via post-OAuth `ctx.waitUntil` + session-init `ensureCatalogue` for stale rows (24h TTL). Admin "Refresh now" available for `none`-strategy upstreams.
- D1 BLOB normalization at the trust boundary in `db/queries/upstream-credentials.getUserCredential` — D1 returns BLOBs in a shape SubtleCrypto rejects; we coerce to `Uint8Array` before handing to `aead.open`.
- Stdio upstreams via bring-your-own-bridge — front the stdio MCP server with your own stdio↔HTTP bridge and register its HTTPS URL as a `streamable_http` upstream. ctxlayer runs no sandbox lifecycle. See [docs/plan/B-stdio-bridge.md](plan/B-stdio-bridge.md).

## Collaborative editor

- **SPA**: `@blocknote/react` + `@blocknote/core` with the Yjs collab extension. The editor builds a per-doc `Y.Doc` + `CollabWSProvider` inside a StrictMode-safe effect; awareness-leader election (lowest clientID) decides which tab fires the REST autosave so concurrent tabs share one revision per debounce window. A connection-status badge ("Live" / "Reconnecting" / "Offline") sits alongside the save UI.
- **Save UX**: explicit **Save** + **Discard** buttons and a navigation guard, with autosave demoted to a background crash-insurance net. Shared `apps/web/src/components/editor/save-controls.tsx` (`SaveBadge` / `SaveControls` / `LeaveGuard`) is used by both the doc editor and the skill editor.
  - The user-facing "saved" state tracks **explicit** saves only: an explicit Save clears the dirty flag and advances the discard baseline (badge → `saved`), while a background autosave only flips the badge to `autosaved` and leaves the nav guard armed. So the user always makes an explicit Save / Discard / Cancel decision before leaving.
  - **Discard** reverts the editor to the baseline (the content as opened, or the last explicit Save). On docs this propagates to every collaborator in the room via Yjs `replaceBlocks`; on skills it's a local revert + save.
  - **Nav guard**: `useBlocker` (in-app navigation; requires the data router in `main.tsx`) + `beforeunload` (tab close / refresh). While dirty, in-app navigation pops a Save & leave / Discard & leave / Cancel modal and only proceeds if the save succeeds.
  - **Autosave reliability**: a 15s per-request timeout (`AbortSignal.timeout`) so a hung `PUT /content` can't wedge the in-flight guard; failures surface on the badge instead of only `console.error`.
  - Idle debounce unified at **3s** via the shared `SAVE_IDLE_MS`; docs keep their separate 30s max-coalesce window (tied to the DO snapshot cadence).
- **Transport**: WebSocket to `/collab/:docId`. Pre-upgrade auth: session cookie + `getDocById` existence + same-origin via `util/origin.ts` (localhost carve-out for Vite HMR). CSRF intentionally not required on the upgrade — the DO never accepts state-changing HTTP, only WebSocket frames tagged read-only or read-write via per-socket attachment.
- **`DocRoomDO`**:
  - WebSocket Hibernation API (`acceptWebSocket` + `webSocketMessage` / `webSocketClose` / `webSocketError`).
  - Lazy-loads `docs/{id}/yjs/snapshot.bin` from R2 on construct / post-eviction wake; immediately sends `syncStep1` to every still-attached socket so peers re-send unflushed in-memory updates.
  - Broadcasts sync + awareness frames via `ctx.getWebSockets()`.
  - **Snapshot on every applied update**, coalesced through a single in-flight write (latest-wins) and held alive via `ctx.waitUntil`. Two gotchas this design avoids: an **alarm-debounced flush is wrong under WS Hibernation** — alarms fire on a fresh DO instance with stale R2 state, so we snapshot per-update instead; and **`@blocknote/server-util` can't run in `workerd`** (it pulls in jsdom), so block→markdown rendering for RAG lives in our own `rag/markdown.ts`.
- **Storage**: `apps/worker/src/storage/docs-r2.ts` adds `readYjsSnapshot` / `writeYjsSnapshot`. Y.Doc bytes live alongside the JSON snapshot/revision tree; no rotation (one current binary snapshot only).

## Usage tracking

- Producer wraps every MCP tool call (built-ins in `mcp/session-do.ts`, proxied in `mcp/tools-proxy.ts`) and tokenises req/resp via `js-tiktoken` cl100k_base. Each call **stages** a pre-computed usage event (bytes + tokens) into the McpSessionDO's SQLite **outbox** (`apps/worker/src/usage/{event,tokens,record,outbox}.ts`); an idempotent `flushUsageOutbox` alarm drains staged rows to `USAGE_QUEUE`. Replaced an earlier per-call `ctx.waitUntil(queue.send)` whose background send was cancelled once the streaming response ended (dropping usage rows). Tool responses never block on the network send.
- Queue consumer (`apps/worker/src/queues/usage-consumer.ts`) acks per-message; writes the raw `usage_events` row and UPSERTs the daily rollup in one D1 batch (`db/queries/usage.ts:writeUsageEvent`). `NULL upstream_id` (built-in) becomes `''` on the rollup PK. Deduplicates on event id (queues are at-least-once and the outbox can re-send a batch it failed to delete), acking a duplicate-PK insert rather than retrying.
- Tokens are documented as **approximate** — `js-tiktoken cl100k_base` is the same encoder the RAG chunker uses; counts won't exactly match Claude's own tokenizer but track within a few %.
- Retention: nightly cron `0 3 * * *` calls `pruneUsageEvents(env, 30)` (`apps/worker/src/index.ts:scheduled`); `usage_rollups_daily` retained indefinitely.

## Admin UI (`/app/admin/*`, role-gated)

- **Teams / Products / Team↔Product matrix**.
- **Upstreams** — list table + drawer with Details (slug locked, all other fields editable + enabled toggle + delete), Visibility (everyone / team checklist / product checklist), Tool-cache (count + last-refreshed + "Refresh now" for `none`-auth upstreams). `+ New upstream` modal. `shared_bearer` + `user_oauth` enabled. Transport is `streamable_http` or `sse`.
- **Users** — `/app/admin/users`: table, promote/demote (last-admin guard), revoke creds, inline team-membership.
- **Usage** — `/app/admin/usage`: stacked bar (req+resp tokens/day) with adaptive X-axis density, top-N tables for tools/upstreams/users, user/upstream filters.
- **OAuth clients** — `/app/admin/oauth-clients`: DCR-registered MCP clients from `OAUTH_KV`, click-through drawer with raw record.
- **Audit log** — `/app/admin/audit`: cursor-paginated tail of `audit_log` with action-prefix + actor filters.

## User UI

- `/sign-in` — GitHub (Google supported but disabled in this deploy).
- `/app/docs` — tree/list + BlockNote editor with Yjs realtime collab, explicit Save/Discard + unsaved-changes nav guard.
- `/app/admin/teams`, `/app/admin/products`, `/app/admin/upstreams`.
- `/upstreams` — cards per enabled upstream: `user_bearer` shows password-input + Connect/Replace/Disconnect; `user_oauth` shows Connect-with-OAuth button (DCR + PKCE round-trip happens here, before the agent session); `none`/`shared_bearer` show an info notice. `?oauth_connected=<slug>` / `?oauth_error=<...>` flash banner on return from the callback.
- `/mcp-setup` — live `${publicBaseUrl}/mcp` snippet + per-client config blocks for Claude (web + Desktop + Code), Cursor/Windsurf/Zed/VS Code, all with one-click copy.
- `/usage` — personal stats: own daily totals + top tools + top upstreams. Range select (7/30/90 days).

## Deployment / configuration

The live `wrangler.toml`, bootstrap script, and migrations are the source of truth — see [`wrangler.toml`](../wrangler.toml) + [`scripts/bootstrap-resources.mjs`](../scripts/bootstrap-resources.mjs). Highlights:

- Single Worker (`name = "ctxlayer"`), Workers Assets ships the SPA from `apps/web/dist`.
- Bindings: D1 (`DB`), KV (`OAUTH_KV`), R2 (`DOCS_BUCKET`), Vectorize (`DOCS_INDEX`), AI, two DOs (`McpSessionDO` SQLite-backed, `DocRoomDO` non-SQLite), two queues (`USAGE_QUEUE`, `DOC_REINDEX_QUEUE`).
- DO migrations collapsed to a single tag (`new_classes = ["DocRoomDO"]` + `new_sqlite_classes = ["McpSessionDO"]`) — CF's validator rejects per-tag delete+create on a fresh account (codes 10021/10074). See [docs/plan/G-conventions.md](plan/G-conventions.md) G3.
- `GIT_SHA` + `BUILT_AT` are injected at deploy via `--var` (`deploy` / `deploy:preview` scripts) and surfaced on `/api/version` + `/api/health`; empty for local dev / a bare `wrangler deploy`.
- Two crons (`triggers.crons`): **nightly** `0 3 * * *` runs `pruneUsageEvents(env, 30)` (drop raw events >30d; rollups kept forever) **and** `pruneOrphanOAuthClients` (abandoned DCR registrations); **hourly** `0 * * * *` is the git-sync due-check (enqueues `shared_bearer` sources whose interval elapsed). Each cron firing stamps `ops:last_cron` in KV for health cron-liveness. Upstream tool-cache refresh is on-demand per-session (24h TTL).
- **Observability**: cron/queue/poison failures are `console.error`'d AND POSTed to `ALERT_WEBHOOK_URL` when set (`ops/alert.ts notify()`, best-effort, no-op unset). `/api/health` checks critical deps (D1 / KV / R2 → 503 on failure) plus soft deps (Vectorize, cron-liveness → reported, no 503). Queue consumers carry `max_retries` and alert on the final attempt instead of silently dropping a poison message. (No Cloudflare DLQ — avoids a per-tenant queue-create burden; the alert is the inspection point.)

`bun run dev` provisions local HTTPS via mkcert (`.dev-tls/`) on first run; the `__Host-ctx_session` cookie requires `Secure` so HTTPS is mandatory even locally. See [docs/plan/G-conventions.md](plan/G-conventions.md) G11–G12 for cookie + cert details.

## Deep-dive index

Topic-specific deep-dives live under [`docs/plan/`](plan/):

- [A — Auth flows (inbound + outbound)](plan/A-auth-flows.md) — DCR, paste-bearer fallback, SPA session, allowlist enforcement, `user_bearer` / `user_oauth` / `shared_bearer` outbound, token & secret matrix.
- [B — Stdio via external HTTP bridge](plan/B-stdio-bridge.md) — bring-your-own-bridge model: operator runs a stdio↔HTTP bridge (e.g. supergateway), exposes Streamable HTTP, registers it as a normal `streamable_http` upstream; per-user creds via the existing strategies; no ctxlayer-managed sandbox lifecycle.
- [C — Upstream proxy mechanics](plan/C-upstream-proxy.md) — `tools/list` aggregation, namespacing edge cases, lazy connect cost analysis, error taxonomy, streaming, subrequest accounting, concurrent calls, `list_upstreams()` shape.
- [D — UI surface + REST endpoints](plan/D-ui-and-rest.md) — sitemap, user screens, admin screens, role gating, full REST catalogue.
- [E — Dev environment](plan/E-dev-environment.md) — session bootstrap, local dev DX, test harness, module conventions, observability, env vars, onboarding checklist.
- [F — Org information architecture](plan/F-org-ia.md) — teams, products, upstream visibility, doc tags; data model additions in `0004_org_ia.sql`; access resolution; default search scope; `list_my_context`; admin UI + REST additions; UX guardrails.
- [G — Conventions](plan/G-conventions.md) — SQLite/D1 quirks, Workers Assets, DO migration rules, Hono entry, Bun/Wrangler, SPA conventions, smoke + seed scripts, admin guardrails, local HTTPS + cookie shape.
- [I — Upstream resilience: long calls + oversized responses](plan/I-upstream-resilience.md) — diagnosis + work items for silent-upstream timeouts and oversized responses: per-upstream timeout overrides, Driver-side progress emission, response-size cap, timeout-rate observability, DO wall-clock verification; plus the usage-outbox follow-up.
- [M — Open Knowledge Format (OKF) interop](plan/M-okf.md) — ctxlayer as an early adopter of [OKF](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md): the doc rail as YAML-frontmatter editor, the field↔frontmatter mapping, import / export / git-write-back flows, the unknown-key preservation contract, free-form (non-slug) tags, and migrations 0025 + 0026.
