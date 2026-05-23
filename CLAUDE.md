# ctxlayer — Claude Code Briefing

This repo is the **agent context layer**: a remote MCP server on Cloudflare that
serves curated docs (with RAG over Vectorize), proxies upstream MCP servers
with centralised per-user credentials, and exposes a React SPA for self
onboarding + collaborative markdown editing + admin/usage analytics.

The full plan lives at **`docs/PLAN.md`**. Read it first.

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
- Stdio upstreams run as Daytona Cloud sandboxes per `(user, upstream)`,
  fronted by a stdio↔HTTP bridge (`supergateway`). HTTP/SSE upstreams are
  proxied directly. See `apps/worker/src/upstream/daytona.ts` (M4).
- All sensitive material is sealed with AES-GCM via `crypto/aead.ts`.

## How a Claude session should work in this repo

1. The SessionStart hook in `.claude/settings.json` runs
   `bun install --frozen-lockfile`.
2. Use the slash commands in `.claude/commands/`:
   - `/smoke` — deploy a preview + hit smoke endpoints + print a status table.
   - `/migrate` — apply pending D1 migrations.
   - `/seed` — load fixture upstreams + docs into local D1.
   - `/snapshot <slug>` — rebuild a single Daytona snapshot (M4+).
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

## Architectural gotchas baked into M1

These all bit us during the scaffold review; do NOT re-introduce them.
Full rationale in `docs/PLAN.md` Section G.

- **SQLite/D1**: no expressions allowed in `PRIMARY KEY`. Use a `''`
  sentinel on `NOT NULL` columns and a partial `UNIQUE INDEX` for
  "at most one nullable-value row" invariants. Every enum-shaped column
  has a matching `CHECK (col IN (...))`.
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
`docs/PLAN.md` Section F.

## Where to start

Milestones live in `docs/PLAN.md` under "Milestone breakdown". Current state:
**M1 complete.** Skeleton + Google/GitHub sign-in + `/api/me` are wired.
Next work is **M2** — `McpAgent` at `/mcp`+`/sse`,
`workers-oauth-provider`, BlockNote editor with REST save, Vectorize
RAG, built-in MCP tools.

Local dev runs over HTTPS (mkcert; first `bun run dev` provisions
`.dev-tls/`). The `__Host-ctx_session` cookie carries an HMAC-signed
`{userId, role, iat, exp}` body keyed by `SESSION_COOKIE_SECRET`; the
sibling `__Host-ctx_oauth_state` cookie carries the redirect-dance
state. See Section G11–G12 in `docs/PLAN.md` for full rationale.
