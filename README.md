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
**[`AGENTS.md`](AGENTS.md)**.

## Quickstart

```bash
pnpm install
cp .dev.vars.example .dev.vars   # fill in secrets
pnpm dev                          # runs Vite (5173) + wrangler dev (8787)
pnpm verify                       # typecheck + tests + smoke
```

Cloud resources have to be created once before deploy:

```bash
wrangler d1 create ctxlayer
wrangler kv namespace create OAUTH_KV
wrangler r2 bucket create ctxlayer-docs
wrangler vectorize create ctxlayer-docs --dimensions 768 --metric cosine
```

Then replace the `<TODO>` IDs in `wrangler.toml` with the values printed by
those commands and run `pnpm migrate:remote`.

## Current state

**M1 scaffold landed.** No auth wired yet. The Worker boots, exposes
`/api/health`, `/api/version`, and a 401-returning `/api/me`; the SPA shell
routes between Docs / Upstreams / MCP setup / Usage placeholders.

Next: M1's IdP sign-in (Google + GitHub with allowlist) and a real
`/api/me`. See `docs/PLAN.md` for the milestone breakdown.
