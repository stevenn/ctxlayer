# ctxlayer — Claude Code Briefing

This repo is the **agent context layer**: a remote MCP server on Cloudflare that
serves curated docs (with RAG over Vectorize), proxies upstream MCP servers
with centralised per-user credentials, and exposes a React SPA for self
onboarding + collaborative markdown editing + admin/usage analytics.

**`docs/PLAN.md`** is the architecture & data-model reference — *not a roadmap*. The
milestone-driven plan that built ctxlayer (M1–M8) is retired; future work proceeds
ad hoc, tracked in code + commits + this file, not in a larger plan. Topic deep-dives
are under **`docs/plan/`** (A: auth, B: stdio bridge, C: upstream proxy, D: UI+REST,
E: dev environment, F: org IA, G: conventions, I: upstream resilience, M: OKF
interop). Skim
PLAN.md for the lay of the land and pull in a deep-dive when the topic comes up —
but trust the code first; these docs are reference, not kept in lockstep with every change.

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
3. Before pushing: `bun run verify` (typecheck + lint + unit + integration
   tests, fully offline; `bun run verify:full` adds smoke).

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
- Don't write new docs/README files unless asked. `docs/PLAN.md` + `docs/plan/`
  are a reference, not a maintained plan — touch them only when an architectural
  fact they state goes stale, never as a per-change bookkeeping obligation.

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
  the runtime. https-only lives in the shared Zod schema (`UpstreamUrl`
  / `GitBaseUrl`). The **self-loop guard** — the URL must not be this
  deployment's own origin — lives in the admin REST handler via
  `isSameOrigin(url, env.PUBLIC_BASE_URL)` (host + normalized port),
  because the env-less shared schema can't see `PUBLIC_BASE_URL`. **Do
  NOT re-introduce a blanket `workers.dev`/`cloudflareworkers.com` TLD
  reject** — it wrongly blocked every legitimate Cloudflare-hosted
  upstream MCP (ctxlayer itself is one). See `url-trust.ts`.
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
  by design.** This is the org-IA "open-read" stance — docs are
  readable org-wide; tags organize and narrow, they do not gate reads.
  **Search follows the same stance: `search_docs` + `/api/search`
  default to open-read (all docs).** `effectiveScope(undefined)` →
  `all: true`; an explicit `scope: { teams, products }` NARROWS
  (intersected with the caller's reachable set, no escalation) but
  nothing is hidden by default. (This replaced the old scoped-by-default
  search, which hid team/product-tagged docs from anyone not in that
  team/product — a solo operator in no team saw almost nothing. See
  commit 2c83665.) Do NOT add per-doc read-ACL on top without confirming
  with the operator; the upstream proxy is the gated-execution surface,
  not docs.

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
  in `apps/web/src/lib/api/core.ts`. Treating schema failures as auth
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
  free-form **tag**) shape what `search_docs` returns by default — they do
  not gate read access. The free-form kind is `doc_tags.tag_kind='tag'`
  (renamed from `topic` in migration 0026); only it maps to OKF `tags`.
- MCP upstreams are invisible until an admin grants visibility to a team
  or product. `list_upstreams` only returns what the user can use.

Schema: `apps/worker/src/db/migrations/0004_org_ia.sql`. Design rationale:
`docs/plan/F-org-ia.md`.

## Open Knowledge Format (OKF)

ctxlayer is an early adopter of the **[Open Knowledge
Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)**
— docs interop with OKF (YAML-frontmatter Markdown bundles) in and out. Full
reference: **`docs/plan/M-okf.md`**. Key facts so you don't re-derive them:

- **The doc editor's right rail *is* the OKF frontmatter editor.** `type` →
  `documents.doc_type`, `description`, `resource` are rail rows; OKF `tags` →
  free-form tags; `title`/`timestamp` → title/updated_at. There is no separate
  OKF panel. `kind` (`doc`/`prompt`) is no longer surfaced — `type` is the
  single concept field; the `kind` column lingers as a vestigial `'doc'`
  default.
- **Serialiser**: `packages/shared/src/frontmatter.ts`
  (`splitFrontmatter`/`parseFrontmatter`/`emitFrontmatter`) — built on the
  `yaml` package's Document API (block scalars, comments, quoted strings, flow
  vs. block lists, scalar `tags:` all handled). The round-trip contract is
  **preservation**: only well-known keys are interpreted; unknown producer keys
  (`okf_version`, …) are kept in `documents.okf_frontmatter` and re-emitted
  verbatim with their comments + ordering via the Document API. `splitFrontmatter`
  still owns the `---`-fence delimiting (not YAML's job).
- **Worker glue**: `apps/worker/src/docs/okf.ts` (export compose + write-back
  reattach). Import parses frontmatter in `git/sync.ts` (+ the SPA import
  modal); the reindex consumer strips frontmatter before chunking so YAML isn't
  embedded as body text; `git/writeback.ts` re-attaches frontmatter only when
  the doc was imported *with* it.
- **Tags are free-form, NOT slugs.** `addDocTags` stores them verbatim (trim +
  whitespace-collapse + cap) so `BigQuery Table` round-trips. Don't re-introduce
  slugification on the tag path — it breaks OKF fidelity.
- Migrations `0025` (OKF columns) + `0026` (`topic`→`tag` rename).

## Where to start

ctxlayer is fully built and runs as a single Cloudflare Worker
(GitHub sign-in; Google supported but off in the reference deploy). Everything in
PLAN.md is shipped: docs + RAG over Vectorize, the BlockNote/Yjs collab editor,
the HTTP/SSE upstream proxy (incl. `user_oauth` DCR+PKCE, AES-GCM creds at rest,
per-upstream timeouts + response-size guard), the admin pages (users / audit /
oauth-clients / usage / upstreams), the usage pipeline, and the skills surface
(`list_skills` / `get_skill`). For *what changed recently*, read `git log` and
the session memory — there is no status section to keep current here.

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
production](README.md#deploying-ctxlayer-to-production)**. The
condensed dev-loop sequence is unchanged: `bun run bootstrap` →
`bun run migrate:remote` → `wrangler secret put` for the IdP creds +
`ENCRYPTION_KEY` + `SESSION_COOKIE_SECRET` + `ADMIN_EMAILS` → first
`bun run deploy` to print the workers.dev URL, then patch
`PUBLIC_BASE_URL` (and ideally pin a custom domain — see README §4)
and redeploy.

For local dev to keep working with the prod base URL committed to
`wrangler.toml`, put `PUBLIC_BASE_URL=https://localhost:8787` in
`.dev.vars` to override `[vars]`. The full production-install steps live
in **[README.md → Deploying ctxlayer to
production](README.md#deploying-ctxlayer-to-production)**.

Local dev runs over HTTPS (mkcert; first `bun run dev` provisions
`.dev-tls/`). The `__Host-ctx_session` cookie carries an HMAC-signed
`{userId, role, iat, exp}` body keyed by `SESSION_COOKIE_SECRET`; the
sibling `__Host-ctx_oauth_state` cookie carries the redirect-dance
state. See G11–G12 in `docs/plan/G-conventions.md` for full rationale.
