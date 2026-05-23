# Working in this repo as an agent

Optimised for Claude-on-the-web and mobile sessions. Keep replies terse,
operate via slash commands and `bun run` scripts, and prefer one-shot
verifies over interactive flows.

## Golden path for any change

1. `bun run verify` — typecheck + unit/integration tests + smoke.
2. Commit with a present-tense, "why" focused message.
3. `git push -u origin <branch>` and open a PR with `gh pr create`.
4. CI runs the same `bun run verify` plus a preview deploy.

## Where things live

- Cloudflare Worker entry → `apps/worker/src/index.ts`
- Durable Objects → `apps/worker/src/mcp/session-do.ts`,
  `apps/worker/src/collab/doc-room-do.ts`
- Hono REST routes → `apps/worker/src/api/*.ts`
- SQL migrations → `apps/worker/src/db/migrations/*.sql`
- React SPA → `apps/web/src/`
- Shared types/schemas → `packages/shared/src/`
- Plan of record → `docs/PLAN.md`

## Module rules

- ≤200 LoC per file. Split early.
- No circular deps across the four top-level concerns:
  `api/`, `mcp/`, `collab/`, `queues/`.
- All env via the typed `Env` from `apps/worker/src/env.ts`.
- All SQL via `apps/worker/src/db/queries/*.ts` — never inline in routes.

## Adding an endpoint

1. Add the Zod schema for body + response to `packages/shared/src/api-types.ts`.
2. Add a tiny handler under `apps/worker/src/api/<concern>.ts` that imports the
   schema, parses the body, calls a helper, returns JSON.
3. Mount it in `apps/worker/src/index.ts`.
4. Add an integration test under `apps/worker/test/`.
5. Add the typed fetch helper in `apps/web/src/lib/api.ts` using the same
   schema.

## Adding a Durable Object

1. Create `*-do.ts` exporting the class.
2. Re-export from `apps/worker/src/index.ts`.
3. Add `[[durable_objects.bindings]]` + `new_sqlite_classes` migration in
   `wrangler.toml`.
4. Reference it through the typed `Env` binding.

## Anti-patterns to avoid

- Buffering upstream MCP response bodies — pipe `ReadableStream` through.
- Calling `console.log` with secrets, env contents, or decrypted creds.
- Adding `process.env.X` — use the typed `Env` binding.
- Writing comments that restate code; comment only non-obvious WHY.
- Creating `*.md` docs that aren't asked for. Update `docs/PLAN.md` instead.

## Known gotchas (don't re-introduce)

The M1 scaffold review surfaced ~25 fixable issues. The conventions
that came out of it are documented in `docs/PLAN.md` **Section G**. The
short list:

- `PRIMARY KEY` cannot contain `COALESCE` or any expression in SQLite/D1.
- Enum columns get a matching `CHECK (col IN (...))`.
- `[assets] not_found_handling = "single-page-application"` is what
  handles SPA fallback. Do not re-add a manual `app.notFound` SPA
  rewrite.
- `run_worker_first` needs both `/mcp` AND `/mcp/*` (same for `/sse`).
- DOs that don't yet use `ctx.storage.sql` go under `new_classes`, not
  `new_sqlite_classes` (sticky decision).
- Use `ExportedHandler<Env>` for the worker default export so `queue`
  and `scheduled` get correct param types.
- Queue dispatcher: retry on unknown queue names; don't silently drop.
- Every workspace must have stubs for `typecheck` / `lint` / `test` —
  `bun --filter='*' run X` silently skips workspaces missing the script.
- `bun install --frozen-lockfile` silently installs without a lockfile;
  the SessionStart hook tests for `bun.lock` first.
- Optional response fields use `.nullish()` (not `.nullable()`) so a
  server that omits the key with `JSON.stringify` doesn't break parsing.
- Fetch helpers distinguish `ApiError(status)` from `ApiSchemaError`.
  Treating schema mismatches as auth failures loops the user.
- Sign-in IdP buttons are gated on `/api/config`. Adding an IdP means
  updating the env vars AND the config endpoint.
- `seed:remote` is its own command. `seed:local` never escalates.
- `wrangler versions upload` for previews; `--x-versions` was removed.
- `apps/web/dist/index.html` must exist for wrangler — that's what
  `scripts/ensure-dist.mjs` (the `predev`/`prebuild`/`predeploy` hook)
  is for.
