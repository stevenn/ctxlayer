# ctxlayer

Agent context layer — an MCP service on Cloudflare that:

- serves curated org docs (Markdown, with Vectorize-backed RAG search) as MCP
  resources/prompts and a `search_docs` tool;
- proxies other MCP servers (HTTP/SSE natively; stdio via Daytona Cloud
  sandboxes per user×upstream), centralising per-user credentials;
- exposes a React + Vite SPA for self-onboarding, BlockNote + Yjs
  collaborative markdown editing, and admin/usage analytics.

The plan of record is **[`docs/PLAN.md`](docs/PLAN.md)**. Briefing for AI
agents working in this repo is **[`CLAUDE.md`](CLAUDE.md)** /
**[`AGENTS.md`](AGENTS.md)**. Architectural conventions and gotchas baked
into the M1 scaffold live in `docs/PLAN.md` **Section G**.

## Quickstart

```bash
brew install mkcert nss           # macOS; see PLAN.md G11 for Linux/Windows
bun install
cp .dev.vars.example .dev.vars    # fill in IdP secrets, ENCRYPTION_KEY, SESSION_COOKIE_SECRET
bun run dev                       # vite https://localhost:5173 + wrangler https://localhost:8787
bun run verify                    # typecheck + tests + smoke
```

The first `bun run dev` calls `scripts/setup-dev-tls.mjs` via the `predev`
hook and generates a locally-trusted cert in `.dev-tls/`. Both Vite and
Wrangler then serve HTTPS — required for the `__Host-` session cookie.

Cloud resources have to be created once before deploy:

```bash
wrangler d1 create ctxlayer
wrangler kv namespace create OAUTH_KV
wrangler r2 bucket create ctxlayer-docs
wrangler vectorize create ctxlayer-docs --dimensions 768 --metric cosine
```

Then replace the `<TODO>` IDs in `wrangler.toml` with the values printed by
those commands and run `bun run migrate:remote`.

## Useful scripts

| Command | What it does |
|---|---|
| `bun run dev` | Vite (https://localhost:5173) + wrangler dev (https://localhost:8787) concurrently |
| `bun run build` | Web (Vite) + worker (wrangler dry-run) |
| `bun run typecheck` | TypeScript across all workspaces |
| `bun run smoke` | Hit `/api/health`, `/api/version`, `/api/config`, `/api/me`, `/.well-known/oauth-authorization-server`, `POST /mcp`, `/sign-in`. Pass `SMOKE_ME_OK=1` if your CI sends a session cookie. |
| `bun run migrate:local` / `migrate:remote` | Apply D1 migrations |
| `bun run seed:local` / `seed:remote` | Seed fixtures. `seed:remote` requires explicit invocation + 3s abort window |
| `bun run deploy` / `deploy:preview` | Build web + worker, deploy. Preview uses `wrangler versions upload`. |

## Current state

**M1 complete.** Skeleton + Google/GitHub sign-in + real `/api/me` are in.
What's wired:

- Bun workspace, Vite SPA, `wrangler.toml` with every binding declared
  (placeholder IDs for D1/KV/R2/Vectorize); local HTTPS via mkcert.
- D1 migrations `0001`–`0004` (users / upstreams / docs / usage rollups
  / org IA — teams, products, upstream visibility, doc tags).
- Worker entry with `/api/health`, `/api/version`, `/api/config`,
  `/api/me` (real, behind `__Host-ctx_session`), `/api/auth/signout`,
  `/idp/google/{start,callback}`, `/idp/github/{start,callback}` with
  domain + org allowlist enforcement; 501 placeholders for `/mcp(/*)`,
  `/sse(/*)`, `/oauth/*`, `/.well-known/*`, `/collab/*`.
- React SPA shell with Docs / Upstreams / MCP-setup / Usage routes for
  users, stubbed admin routes for M5, sign-in page that renders friendly
  errors from the IdP redirect dance.
- Per-user encrypted-at-rest credential helpers + queue scaffolding
  ready for M2.

Next: **M2** — `McpAgent` mounted at `/mcp` + `/sse`, `workers-oauth-provider`
wired, BlockNote editor with REST save, Vectorize-backed RAG, built-in
tools `search_docs` / `get_doc`. See `docs/PLAN.md` milestone breakdown.
