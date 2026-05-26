# Dev environment and team experience

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
| Unit | Vitest (node env) | Pure functions (chunker, token estimator, allowlist, namespacing, AES-GCM wrapper). 106 tests, ≤500ms total. Live under `apps/worker/src/**/*.test.ts`. | Every change, every PR (`bun run test`). |
| Integration | Vitest + `@cloudflare/vitest-pool-workers` against a real D1 (miniflare-backed) | Query-layer coverage: usage rollup math, doc-ACL gates, audit-log pagination. Migrations applied via `applyD1Migrations` in a `setupFiles` hook; per-test isolated storage rolls back inserts. 23 tests, ~600ms. Live under `apps/worker/test/integration/`. | Locally + nightly (`bun run test:int`). Not in `bun run verify` to keep that fast. |
| End-to-end | Playwright | SPA sign-in, doc edit (two browsers), upstream connect, MCP setup, admin CRUD. Runs against a `wrangler versions deploy` preview URL. | 🚧 not yet wired; the `test:e2e` script is a stub. |

Special harnesses (planned, not all shipped):
- `tests/fixtures/fake-idp/` — minimal OIDC issuer + GitHub-shaped API for Google and GitHub allowlist tests. No external dependency. 🚧 not yet built.
- `tests/fixtures/fake-upstream-mcp/` — a tiny in-process MCP server (Streamable HTTP) that the integration tests register as an upstream. Verifies proxy + namespacing + error surfacing end-to-end. 🚧 not yet built.
- `tests/fixtures/mock-daytona/` — express server speaking Daytona's REST API shape; sandbox state machine is purely in-memory. Lets integration tests cover the stdio path without any container runtime. 🅿️ parked with the Daytona track.

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

