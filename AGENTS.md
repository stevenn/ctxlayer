# Working in this repo as an agent

Optimised for Claude-on-the-web and mobile sessions. Keep replies terse,
operate via slash commands and `pnpm` scripts, and prefer one-shot verifies
over interactive flows.

## Golden path for any change

1. `pnpm verify` — typecheck + unit/integration tests + smoke.
2. Commit with a present-tense, "why" focused message.
3. `git push -u origin <branch>` and open a PR with `gh pr create`.
4. CI runs the same `pnpm verify` plus a preview deploy.

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
