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
bun install
cp .dev.vars.example .dev.vars   # fill in secrets
bun run dev                       # vite (5173) + wrangler dev (8787)
bun run verify                    # typecheck + tests + smoke
```

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
| `bun run dev` | Vite (5173) + wrangler dev (8787) concurrently |
| `bun run build` | Web (Vite) + worker (wrangler dry-run) |
| `bun run typecheck` | TypeScript across all workspaces |
| `bun run smoke` | Hit `/api/health`, `/api/version`, `/api/config`, `/api/me`, `/.well-known/oauth-authorization-server`, `POST /mcp`, `/sign-in`. Pass `SMOKE_ME_OK=1` if your CI sends a session cookie. |
| `bun run migrate:local` / `migrate:remote` | Apply D1 migrations |
| `bun run seed:local` / `seed:remote` | Seed fixtures. `seed:remote` requires explicit invocation + 3s abort window |
| `bun run deploy` / `deploy:preview` | Build web + worker, deploy. Preview uses `wrangler versions upload`. |

## Current state

**M1 scaffold landed + code-reviewed.** Two finder passes (5 angles + a
gap sweep) surfaced ~30 candidates; the actionable ones were patched in
place (see commit `9e62c26`). What's wired:

- Bun workspace, Vite SPA, `wrangler.toml` with every binding declared
  (placeholder IDs for D1/KV/R2/Vectorize);
- D1 migrations `0001`–`0004` (users / upstreams / docs / usage rollups
  / org IA — teams, products, upstream visibility, doc tags);
- Worker entry with `/api/health`, `/api/version`, `/api/config`,
  `/api/me` (returns 401 until sign-in lands), 501 placeholders for
  `/mcp(/*)`, `/sse(/*)`, `/oauth/*`, `/idp/*`, `/collab/*`,
  `/.well-known/*`;
- React SPA shell with Docs / Upstreams / MCP-setup / Usage routes for
  users and stubbed admin routes for M5;
- `scripts/ensure-dist.mjs` (pre-deploy placeholder for Workers Assets),
  `scripts/seed.mjs` (safe `--local` default), `scripts/smoke.mjs`
  (env-toggled expectations);
- `CLAUDE.md` / `AGENTS.md` / `.claude/settings.json` (SessionStart hook
  that refuses to install without `bun.lock`) / `.claude/commands/*`
  slash commands.

Next: M1's IdP sign-in leg (Google + GitHub callbacks, allowlist
enforcement) and a real `/api/me`. See `docs/PLAN.md` milestone
breakdown.
