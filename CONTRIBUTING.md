# Contributing to ctxlayer

Thanks for your interest in ctxlayer! This guide is for **human contributors**.
If you're driving changes with an AI coding agent, point it at
[`AGENTS.md`](AGENTS.md) and [`CLAUDE.md`](CLAUDE.md) as well — they encode the
same conventions in agent-facing form.

## Getting set up

ctxlayer is a Bun monorepo (a single Cloudflare Worker + a Vite/React SPA +
shared types + a CLI). You need:

- **Bun ≥ 1.3** and **Node ≥ 22**
- `mkcert` (local HTTPS — the `__Host-` session cookie requires it)
- No Cloudflare account is needed for the local dev loop; miniflare emulates
  D1, KV, R2, and Queues offline.

Follow the **[Quickstart in the README](README.md#quickstart-contributors-hacking-on-ctxlayer)**
to get `bun run dev` working (TLS provisioning, `.dev.vars`, a GitHub OAuth
app, `migrate:local`, `seed:local`). Two things newcomers miss: you must
create an IdP app to sign in, and `search_docs` returns nothing locally
because Vectorize has no local emulator — both are expected.

## The change loop

1. Branch from `main`.
2. Make your change. Keep it small and focused.
3. **`bun run verify`** — typecheck + lint (Biome) + unit + integration tests,
   fully offline. This is the gate; a PR should be green here. `bun run
   verify:full` also runs the `smoke` suite, which needs a running Worker
   (`bun run dev:worker`) or a preview URL — handy but not required for most
   changes.
4. `bun run format` (Biome) before pushing to normalise style.
5. Open a PR with a present-tense, "why"-focused description. There is no
   hosted CI — please run `verify` yourself first.

## Conventions

These are enforced by review, not just style preference. The rationale lives in
[`docs/plan/G-conventions.md`](docs/plan/G-conventions.md).

- **~200 LoC per module.** Split early; one folder = one concern.
- **No circular imports** across `apps/worker/src/*` concern folders.
- **All env access** goes through the typed `Env` in `apps/worker/src/env.ts` —
  never `process.env`.
- **All SQL** lives in `apps/worker/src/db/queries/*.ts`. Route handlers stay
  SQL-free.
- **The wire is a contract.** Request/response shapes are Zod schemas in
  `packages/shared/src/`, validated on the Worker side and parsed on the SPA
  side. Add the schema there first, then use it on both ends.
- **Adding an endpoint / a Durable Object?** Follow the step lists in
  [`AGENTS.md`](AGENTS.md), and the per-endpoint security checklist there
  (CSRF on mutations, URL validation at the trust boundary, never log token
  bodies or echo upstream errors verbatim).
- Don't add new `docs/`/README files unless asked. `docs/PLAN.md` is a
  reference, not a per-change changelog.

## Repo layout

| Path | What |
|---|---|
| `apps/worker/` | The Cloudflare Worker — MCP server, OAuth provider, REST API, IdP, collab, the SPA host |
| `apps/web/` | The React + Vite SPA |
| `packages/shared/` | Zod schemas + types shared across Worker and SPA (the wire contract) |
| `packages/cli/` | The `ctxlayer` CLI (login, pull skills, draft-skill) |
| `docs/PLAN.md`, `docs/plan/` | Architecture reference + topic deep-dives (A–I) |

## Reporting bugs & ideas

Open an issue describing what you observed vs. expected, with steps to
reproduce. For **security issues, do not open a public issue** — see
[`SECURITY.md`](SECURITY.md).

## Licensing

By contributing you agree your contributions are licensed under the project's
[MIT License](LICENSE).
