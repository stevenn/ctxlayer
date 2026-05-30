# ctxlayer — Claude Code Briefing

This repo is the **agent context layer**: a remote MCP server on Cloudflare that
serves curated docs (with RAG over Vectorize), proxies upstream MCP servers
with centralised per-user credentials, and exposes a React SPA for self
onboarding + collaborative markdown editing + admin/usage analytics.

The full plan lives at **`docs/PLAN.md`**. Topic deep-dives are under **`docs/plan/`** (A: auth, B: stdio bridge, C: upstream proxy, D: UI+REST, E: dev environment, F: org IA, G: conventions). Read PLAN.md first; pull in a deep-dive when the topic comes up.

## What runs where

- **Cloudflare Worker** (`apps/worker/`) is the single deployable unit. It
  hosts: the MCP server (`/mcp`, `/sse`), the OAuth provider (`/oauth/*`,
  `/.well-known/oauth-authorization-server`), REST endpoints for the SPA
  (`/api/*`), IdP callbacks (`/idp/*`), the realtime collab endpoint
  (`/collab/:id`), and the React SPA via Workers Assets.
- **React SPA** (`apps/web/`) is built with Vite and shipped from
  `apps/web/dist` by the Worker.
- **Shared types** (`packages/shared/`) — Zod schemas + types used by both
  Worker and SPA.

## Architecture pointers

- MCP per-session state → Durable Object `McpSessionDO`
  (`apps/worker/src/mcp/session-do.ts`).
- Per-doc realtime collab → Durable Object `DocRoomDO`
  (`apps/worker/src/collab/doc-room-do.ts`).
- HTTP/SSE upstreams are proxied directly through the generic
  `UpstreamClient` interface (`apps/worker/src/upstream/*.ts`). Stdio MCP
  servers are not run by ctxlayer: the operator fronts them with their own
  stdio↔HTTP bridge (e.g. `supergateway`) and registers the resulting HTTP
  URL as an ordinary `streamable_http` upstream (bring-your-own-bridge).
- All sensitive material is sealed with AES-GCM via `crypto/aead.ts`.

## How a Claude session should work in this repo

1. The SessionStart hook in `.claude/settings.json` runs
   `bun install --frozen-lockfile`.
2. Use the slash commands in `.claude/commands/`:
   - `/smoke` — deploy a preview + hit smoke endpoints + print a status table.
   - `/migrate` — apply pending D1 migrations.
   - `/seed` — load fixture upstreams + docs into local D1.
   - `/deploy:preview` — deploy a versioned preview and print the URL.
3. Before pushing: `bun run verify` (typecheck + tests + smoke).

## Conventions

- Module size cap: ~200 LoC. Split when it grows.
- One folder = one concern. No circular imports across `apps/worker/src/*`.
- All env access goes through the typed `env.ts` — never `process.env`.
- D1 queries live in `apps/worker/src/db/queries/*.ts`; route handlers stay
  SQL-free.
- Hono routes are tiny; logic lives in helpers under the sibling concern
  folder.
- Every workspace declares stubs for `typecheck` / `lint` / `test` even if
  they just `echo`. `bun --filter='*' run X` silently skips workspaces
  missing the script, so the stubs are the only thing keeping cross-cuts
  honest.
- Don't write new docs/README files unless asked. Update `docs/PLAN.md`.

## Security gotchas (from 2026-05-26 review)

Durable rules surfaced by the multi-agent code review. Re-introducing
any of these on a new endpoint or proxy hop is a regression.

- **Never log token-exchange response bodies.** `idp/{google,github}.ts`
  used to `console.error(await tokenRes.text())` on failure — that
  string can contain access/id tokens or detailed IdP error meta that
  leak to centralised logs. Log HTTP status and error code only.
- **Never echo upstream MCP error messages verbatim to the agent.**
  `mcp/tools-proxy.ts` returns proxied-tool errors to the caller; the
  message field must be a generic code (`upstream_error`, `timeout`)
  with the real text logged server-side only. Upstream errors can
  carry API keys, internal hostnames, or stack traces.
- **Untrusted upstream tool descriptions are model input.** When a tool
  description from a third-party MCP server is forwarded to the agent
  (via `mcp/tools-proxy.ts`), strip control characters and treat it as
  untrusted prompt content. Never inline-concatenate it into a prompt
  template without sanitisation.
- **Validate upstream URLs at the trust boundary.** Admin can register
  any URL on `/api/admin/upstreams`; the `global_fetch_strictly_public`
  compatibility flag (set in `wrangler.toml`) blocks RFC 1918 ranges at
  the runtime, but defensive checks (https-only, hostname not in
  `cloudflareworkers.com`/`workers.dev` to avoid loops) belong in the
  admin REST handler too.
- **Clear the IdP state cookie on every completion path.**
  `idp/complete-mcp.ts` and the IdP `/callback` success branches both
  set `clearStateCookie()`. Any new completion path (additional IdP,
  alternative success/failure branch) must do the same — relying on
  the 10-minute cookie TTL alone is hygiene, not defense.
- **Allowlist failures expose the configured shape.** `?error=wrong_domain`
  vs `not_in_org` tells an outside attacker which IdP allowlist style
  is in use. Acceptable for now (the error is also a UX signal for
  legitimate users hitting the wrong IdP), but if you tighten this,
  collapse to a single `access_denied` and log the real reason.
- **`requireCsrf` is per-mutation, not router-wide on admin routes.**
  `admin-users.ts` applies `requireCsrf` to PATCH/DELETE inline rather
  than via `.use('*', requireCsrf)` (which is what `admin-teams.ts`
  uses). When adding a new mutation to an admin router, double-check
  the CSRF gate is present on that specific route.
- **`listDocs` returns every non-deleted doc to every signed-in user
  by design.** This is the org-IA "open-read" stance — tags filter
  `search_docs` defaults but do not gate reads. Do NOT add per-doc
  read-ACL on top without confirming with the operator; the upstream
  proxy is the gated-execution surface, not docs.

## Architectural gotchas baked into M1

These all bit us during the scaffold review; do NOT re-introduce them.
Full rationale in `docs/plan/G-conventions.md`.

- **SQLite/D1**: no expressions allowed in `PRIMARY KEY`. Use a `''`
  sentinel on `NOT NULL` columns and a partial `UNIQUE INDEX` for
  "at most one nullable-value row" invariants. Every enum-shaped column
  has a matching `CHECK (col IN (...))`. **Never rebuild a *referenced
  parent* table relying on `PRAGMA foreign_keys=OFF`** — that pragma
  no-ops inside D1's migration transaction, so `DROP TABLE` cascades and
  wipes child rows (0013 silently nuked `upstream_visibility` grants +
  creds + cached tools this way). Snapshot children → swap parent →
  restore. Full rule in `docs/plan/G-conventions.md` §G1.
- **Workers Assets SPA fallback**: lives in `[assets]
  not_found_handling = "single-page-application"`, NOT in a hand-rolled
  `app.notFound`. `run_worker_first` lists both bare and glob forms
  (`/mcp` + `/mcp/*`).
- **Durable Objects**: stubs use `new_classes`, not
  `new_sqlite_classes` (storage backend is sticky once chosen).
- **Worker entry**: typed as `ExportedHandler<Env>` so `queue` and
  `scheduled` get the right `ctx` / controller types. Queue dispatcher
  retries on unknown queue names instead of silently dropping.
- **SPA auth flow**: distinguish `ApiError(401)` from `ApiSchemaError`
  in `apps/web/src/lib/api.ts`. Treating schema failures as auth
  failures causes redirect loops.
- **Bun lockfile**: `bun install --frozen-lockfile` silently installs
  without a lockfile. SessionStart hook tests for `bun.lock` first.
- **Wrangler preview**: `wrangler versions upload` (the
  `--x-versions` flag was retired in wrangler 4).
- **`apps/web/dist`**: must exist for `wrangler dev`/`deploy`.
  `scripts/ensure-dist.mjs` lays a placeholder via `predev`/`prebuild`/
  `predeploy` hooks in `apps/worker/package.json`.
- **`seed:remote`** is a separate command from `seed:local` — never let
  `seed.mjs` default to remote.

## Org information architecture

Each install serves one org. Inside the org we model **teams** (who people
belong to) and **products** (what the org delivers). Defaults are "spread
context, gate execution":

- Docs are open-read by everyone signed in. Tags on docs (team / product /
  topic) shape what `search_docs` returns by default — they do not gate
  read access.
- MCP upstreams are invisible until an admin grants visibility to a team
  or product. `list_upstreams` only returns what the user can use.

Schema: `apps/worker/src/db/migrations/0004_org_ia.sql`. Design rationale:
`docs/plan/F-org-ia.md`.

## Where to start

Status snapshot (full breakdown + verification checklist in `docs/PLAN.md`):

- **M1 + M2 + M3 closed (May 2026).** GitHub sign-in (Google supported
  but off in the live deploy), per-doc ACL, BlockNote editor with
  sharing / tags / admin teams+products, full RAG pipeline
  (`rag/{markdown,chunker,embedder,index}.ts`, Workers AI
  `@cf/baai/bge-base-en-v1.5`, Vectorize upsert with `chunk_count`
  orphan cleanup), MCP server (`McpSessionDO` extends `McpAgent`)
  registering `whoami` / `list_my_context` / `list_upstreams` /
  `get_doc` / `search_docs`, OAuth provider mounted at `/oauth/*` +
  `/.well-known/oauth-authorization-server` with SSR'd IdP chooser,
  doc resources at `mcp://ctxlayer/docs/{id}`. Realtime collab via
  `DocRoomDO` (`collab/doc-room-do.ts`) — Yjs over WS Hibernation at
  `/collab/:docId`, per-update R2 snapshot held by `ctx.waitUntil`,
  resync-on-wake closes the eviction window. SPA `CollabWSProvider`
  (`apps/web/src/lib/yjs-ws-provider.ts`) wires BlockNote's collab
  extension; awareness-leader election drives a single REST autosave
  per ~5s debounce so concurrent tabs don't multiply revisions.
  Shared `util/origin.ts` allowlist (localhost carve-out) lets Vite
  HMR at `:5173` talk to wrangler at `:8787` in dev. Validated
  end-to-end via Claude Web → real Vectorize + two-tab live edit
  on workers.dev.
- **M4 closed (May 2026)**: HTTP/SSE upstream proxy with the
  `user_oauth` flow pulled forward from the original M5 plan.
  `crypto/aead.ts` (AES-GCM at rest), `upstream/http-client.ts`
  (MCP SDK Client per (session,upstream) with 60s wall cap),
  `mcp/tools-proxy.ts` (namespacing + dispatch + per-session
  registry), `mcp/json-schema-to-zod.ts` (faithful tools/list
  re-emission), `upstream/oauth-provider.ts` (MCP SDK's
  `OAuthClientProvider` impl — DCR + PKCE + sealed token
  bundles), `api/admin-upstreams.ts` + `api/upstreams.ts` +
  `api/upstream-oauth.ts`. One real gotcha worth remembering:
  D1 returns BLOB columns in a shape SubtleCrypto rejects —
  `db/queries/upstreams.getUserCredential` normalises to
  `Uint8Array` at the trust boundary.
- **M5 closed (May 2026)**: admin Users (`/app/admin/users` —
  promote/demote + revoke creds + last-admin guard), admin
  Audit-log viewer (`/app/admin/audit`), admin OAuth-clients
  viewer (`/app/admin/oauth-clients` reads `OAUTH_KV` via
  shared `oauth/provider-config.ts`), `shared_bearer` storage
  (migration `0007`), real `/app/mcp-setup` per-client snippets.
  Bundled side features: folder organisation for docs (path-on-doc,
  no folders table), per-doc lock (`canLock` ACL + 423 response),
  modal-dialog system replacing `window.confirm`, doc-move UI.
- **M6 closed (May 2026)**: usage pipeline + dashboards. Per-tool
  call counts, byte sizes, tiktoken-approximated tokens, daily
  rollups via the `ctxlayer-usage` queue consumer, admin + user
  usage pages with period-adaptive bar charts, nightly cron prunes
  `usage_events` older than 30d.
- **Stdio upstreams (bring-your-own-bridge)**: ctxlayer does not run or
  sandbox stdio MCP servers. The operator runs their own stdio↔HTTP bridge
  (e.g. `supergateway`) and registers its HTTP URL as a normal
  `streamable_http` upstream; per-user creds use the existing
  `user_bearer` / `user_oauth` strategies. The proxy is built around a
  generic `UpstreamClient` interface so future transports can slot in. The
  old vendor-specific stdio transport literal (0001 CHECK constraint) and the
  unused sandbox-sessions table are dropped by migration `0013`.
  Recipe: `docs/plan/B-stdio-bridge.md`.

**Local dev** (sign-in, docs CRUD, sharing, tags, admin pages):

- `bun run dev:worker` (terminal 1) + `bun run dev:web` (terminal 2)
  is the recommended workflow — clean per-process logs, no
  cross-stream interleaving, wrangler's interactive UI works.
  Use this for backend debugging where elided stack traces under
  `concurrently` would otherwise bite.
- `bun run dev` is the one-window combined runner (`concurrently`
  with `worker`/`web` prefixes). Convenient but mixes streams; not
  ideal when chasing a backend bug.

The reindex consumer soft-skips Vectorize in dev so saves don't drop
after retries; `search_docs` returns nothing locally because no
vectors land — that's expected.

**End-to-end RAG validation** (search_docs hitting real Vectorize)
requires a real deploy. `wrangler dev --remote` is NOT a viable
shortcut — it emits "Queues are not yet supported in wrangler dev
remote mode" + "SQLite in Durable Objects is only supported in local
mode" warnings, and SPA routes 503 because the McpSessionDO can't
boot SQLite-backed in that mode.

The full production install (resource provisioning, IdP setup, custom
domain) lives in **[README.md → Deploying ctxlayer to
production](../README.md#deploying-ctxlayer-to-production)**. The
condensed dev-loop sequence is unchanged: `bun run bootstrap` →
`bun run migrate:remote` → `wrangler secret put` for the IdP creds +
`ENCRYPTION_KEY` + `SESSION_COOKIE_SECRET` + `ADMIN_EMAILS` → first
`bun run deploy` to print the workers.dev URL, then patch
`PUBLIC_BASE_URL` (and ideally pin a custom domain — see README §4)
and redeploy.

For local dev to keep working with the prod base URL committed to
`wrangler.toml`, put `PUBLIC_BASE_URL=https://localhost:8787` in
`.dev.vars` to override `[vars]`. The full done-done checklist lives
in `docs/PLAN.md` under the M2 verification entry.

Local dev runs over HTTPS (mkcert; first `bun run dev` provisions
`.dev-tls/`). The `__Host-ctx_session` cookie carries an HMAC-signed
`{userId, role, iat, exp}` body keyed by `SESSION_COOKIE_SECRET`; the
sibling `__Host-ctx_oauth_state` cookie carries the redirect-dance
state. See G11–G12 in `docs/plan/G-conventions.md` for full rationale.
