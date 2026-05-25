# ctxlayer

Agent context layer — an MCP service on Cloudflare that:

- serves curated org docs (Markdown, with Vectorize-backed RAG search) as MCP
  resources and a `search_docs` tool;
- proxies other MCP servers (HTTP/SSE natively today; stdio via Daytona
  Cloud is designed but parked), centralising per-user credentials sealed
  at rest;
- exposes a React + Vite SPA for self-onboarding, BlockNote + Yjs
  collaborative markdown editing, admin upstream management, and (later)
  usage analytics.

The plan of record is **[`docs/PLAN.md`](docs/PLAN.md)**. Briefing for AI
agents working in this repo is **[`CLAUDE.md`](CLAUDE.md)** /
**[`AGENTS.md`](AGENTS.md)**. Architectural conventions and gotchas baked
into the M1 scaffold live in `docs/plan/G-conventions.md`.

## Current state (2026-05-25)

| Milestone | Status | What works |
|---|---|---|
| **M1** — Skeleton + sign-in | ✅ done | GitHub / Google sign-in with allowlist, real `/api/me` |
| **M2** — Docs + RAG via MCP | ✅ done | BlockNote editor with revisions, R2 snapshots, Vectorize embedding pipeline, MCP server at `/mcp` with `search_docs` / `get_doc` / `whoami` / `list_my_context` / `list_upstreams`, doc resources, admin teams + products + tags |
| **M3** — Realtime collab (Yjs) | ✅ done | `DocRoomDO` over WS Hibernation, BlockNote Yjs extension, awareness-leader REST autosave, R2-backed snapshots |
| **M4** — Upstream proxy (HTTP/SSE + OAuth) | ✅ done | AES-GCM creds, MCP SDK Client for Streamable HTTP / SSE, namespaced tool aggregation, JSON-Schema → Zod schema preservation, full admin UI for upstreams, user `/upstreams` page with paste-bearer + OAuth. **Validated end-to-end against Notion MCP via Claude Desktop** — search, fetch, create-page. |
| **M5** — Admin polish | ⏳ next | Admin Users / OAuth-clients / Audit pages, `shared_bearer` storage |
| **M6** — Usage pipeline + dashboards | 📋 planned | Per-user/upstream call + token charts |
| **Later** — Stdio upstreams via Daytona | 🅿️ parked | Revisit when a real stdio upstream is in scope |

## Quickstart (contributors hacking on ctxlayer)

These steps are for **local development of this codebase**. End users of a
deployed ctxlayer and operators standing it up don't need any of this; see
[Deploying ctxlayer](#deploying-ctxlayer) below.

```bash
brew install mkcert nss           # macOS contributors only; see docs/plan/G-conventions.md G11 for Linux/Windows
bun install
cp .dev.vars.example .dev.vars    # fill in IdP secrets, ENCRYPTION_KEY, SESSION_COOKIE_SECRET
bun run dev                       # or split-terminals: dev:worker + dev:web (recommended)
bun run verify                    # typecheck + tests + smoke
```

The first dev run calls `scripts/setup-dev-tls.mjs` via the `predev` hook
and generates a locally-trusted cert in `.dev-tls/`. Both Vite and Wrangler
then serve HTTPS on localhost — required for the `__Host-` session cookie
to work in dev. The cert never leaves your machine.

### Backend + frontend in separate terminals (recommended)

When you're debugging the worker (especially OAuth, MCP, or anything where
elided stack traces would bite), run each process in its own terminal so
streams don't interleave and wrangler's interactive UI works correctly:

```bash
# Terminal 1 — worker only (wrangler on https://localhost:8787)
bun run dev:worker

# Terminal 2 — SPA only (vite on https://localhost:5173)
bun run dev:web
```

To defeat wrangler's log-elision (which folds long stack traces into
`[N lines elided]`), pipe to a file:

```bash
bun run dev:worker 2>&1 | tee worker.log
# in another pane:
tail -f worker.log | grep -E '\[oauth\]|\[catalogue\]'
```

### One-window combined runner

```bash
bun run dev                       # concurrently with worker,web prefix-coloured streams
```

Convenient for SPA-focused work; less ideal when chasing a backend bug
because the two streams share one TTY and wrangler's elision is heavier.

## Wiring Claude to a local ctxlayer

`mcp-remote` shims a remote MCP server into Claude Desktop's stdio MCP
interface and handles the OAuth dance. Because localhost uses an mkcert
root that Electron-bundled Node won't trust by default, point Node at the
mkcert CA explicitly.

```bash
mkcert -CAROOT
# /Users/<you>/Library/Application Support/mkcert
```

`~/Library/Application Support/Claude/claude_desktop_config.json`:

```jsonc
{
  "mcpServers": {
    "ctxlayer-local": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://localhost:8787/mcp"],
      "env": {
        "NODE_EXTRA_CA_CERTS": "/Users/<you>/Library/Application Support/mkcert/rootCA.pem"
      }
    }
  }
}
```

Fully quit Claude Desktop (`⌘Q`) and relaunch. On first run mcp-remote
opens a browser tab for OAuth + GitHub sign-in; tokens persist in
`~/.mcp-auth/`.

Before connecting Claude, **connect upstreams in the browser first** at
`https://localhost:5173/upstreams` — the proxy registry only registers
proxied tools (`notion__*`, etc.) for users who have stored credentials at
session-init time.

## Deploying ctxlayer

If you're standing up an instance of ctxlayer for your org (no source
edits), you don't need `bun run dev` or `mkcert`. Cloudflare's edge
provides real HTTPS for the public hostname automatically.

Cloud resources have to be created once before the first deploy
(`bun run bootstrap` automates this; the manual form is below):

```bash
wrangler d1 create ctxlayer
wrangler kv namespace create OAUTH_KV
wrangler r2 bucket create ctxlayer-docs
wrangler vectorize create ctxlayer-docs --dimensions 768 --metric cosine
```

Then replace the `<TODO>` IDs in `wrangler.toml` with the values printed by
those commands, configure your IdP + ctxlayer secrets via
`wrangler secret put` (one each for `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`,
`ENCRYPTION_KEY`, `SESSION_COOKIE_SECRET`, `ALLOWED_GITHUB_USERS` or
`ALLOWED_GOOGLE_EMAILS`, `ADMIN_EMAILS`), set `PUBLIC_BASE_URL` to your
real domain in `wrangler.toml [vars]`, and run `bun run migrate:remote`
followed by `bun run deploy`. Full done-done checklist in
[`docs/PLAN.md`](docs/PLAN.md) → **Verification plan** → **M2**.

## Useful scripts

| Command | What it does |
|---|---|
| `bun run dev` | Vite + wrangler dev in one terminal via `concurrently` |
| `bun run dev:worker` | wrangler dev only (`https://localhost:8787`) |
| `bun run dev:web` | Vite dev only (`https://localhost:5173`) |
| `bun run build` | Web (Vite) + worker (wrangler dry-run) |
| `bun run typecheck` | TypeScript across all workspaces |
| `bun run test` | Vitest unit tests across all workspaces (89 tests as of M4) |
| `bun run verify` | typecheck + test + smoke |
| `bun run smoke` | Hit `/api/health`, `/api/version`, `/api/config`, `/api/me`, `/.well-known/oauth-authorization-server`, `POST /mcp`, `/sign-in`. Pass `SMOKE_ME_OK=1` if your CI sends a session cookie. |
| `bun run bootstrap` | Provision D1 / KV / R2 / Vectorize / queues and patch IDs into `wrangler.toml` |
| `bun run migrate:local` / `migrate:remote` | Apply D1 migrations |
| `bun run seed:local` / `seed:remote` | Seed fixtures. `seed:remote` requires explicit invocation + 3s abort window |
| `bun run deploy` / `deploy:preview` | Build web + worker, deploy. Preview uses `wrangler versions upload`. |
| `bun run logs` / `logs:all` / `logs:mcp` | `wrangler tail` filters (errors / all / `/mcp` traffic) against the live deploy |

## Layout

```
apps/worker/      Cloudflare Worker — Hono routes, MCP server, OAuth provider,
                  DOs (McpSessionDO + DocRoomDO), upstream proxy, queue consumers
apps/web/         React SPA — Vite, BlockNote editor, admin pages, /upstreams
packages/shared/  Zod schemas + types shared between worker and SPA
docs/             PLAN.md + topic deep-dives under docs/plan/
infra/            (parked) Daytona snapshot Dockerfiles for the stdio track
scripts/          Bootstrap, dev-TLS, smoke, seed
```
