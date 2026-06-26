# Conventions captured by the M1 scaffold

Findings from the M1 scaffold pass + multi-angle code review (~30
candidates surfaced, ~25 fixed in place). These are the load-bearing
gotchas the rest of the build should respect.

### G1. SQLite / D1

- **No expressions in `PRIMARY KEY`**. SQLite rejects
  `PRIMARY KEY (a, COALESCE(b, ''))`. When the conceptual key has a
  nullable "self" column, use an empty-string sentinel on `NOT NULL`
  columns and a partial `UNIQUE INDEX … WHERE col = 'sentinel'` to
  enforce uniqueness. See `usage_rollups_daily.upstream_id` (`''` =
  built-in / self) and `upstream_visibility.scope_id` (`''` =
  `scope_kind='everyone'`).
- **CHECK every enum-shaped column**. Every column whose Zod schema
  is an `enum(...)` has a matching `CHECK (col IN (...))` in SQL.
  Examples: `users.role`, `users.idp`, `upstream_servers.transport`,
  `upstream_servers.auth_strategy`, `documents.kind`,
  `usage_events.status`, `team_members.role`, `doc_tags.tag_kind`,
  `upstream_visibility.scope_kind`. Keeps ad-hoc `wrangler d1 execute`
  edits from inserting values the SPA can't render.
- **`PRAGMA foreign_keys=OFF` does NOT work inside a D1 migration.**
  D1 runs each migration file in an implicit transaction, and
  `PRAGMA foreign_keys` can only be toggled when no transaction is
  open — so the statement silently no-ops and FK enforcement stays
  ON. This bit us in `0013`: the textbook table-rebuild of the
  *referenced parent* `upstream_servers` (`CREATE _new` → copy →
  `DROP` old → rename) relied on that pragma to stop the `DROP` from
  cascading. It didn't: `DROP TABLE` with FKs on runs an implicit
  `DELETE` that fires `ON DELETE CASCADE` on every child, wiping
  `upstream_tools`, `user_credentials`, `upstream_visibility`
  (the "everyone" grants), `upstream_shared_credentials`, and the
  `*_attachments`. (`usage_events` survived — its `upstream_id` has
  no FK.) `0028` then showed the rebuild is harder still when the
  parent has a NOT-NULL `NO ACTION` child: D1 records a NO-ACTION FK
  violation the instant a parent row is deleted and **never clears
  it** — even re-`INSERT`ing the same id (which `DROP`+`RENAME` does)
  fails the commit-time check, so the `DROP` cannot proceed at all
  while such a child has rows. **Rules for any future rebuild of a
  table that other tables reference:**
  1. Prefer NOT rebuilding a referenced parent at all. A CHECK can
     only be changed by rebuild, but consider whether app-layer
     validation suffices instead of tightening the DB CHECK. The
     in-place shortcuts are both unavailable on D1: `PRAGMA
     writable_schema` returns `SQLITE_AUTH` (blocked) and `PRAGMA
     legacy_alter_table` is ignored (the rename-swap still rewrites
     child FK refs, so the old table's `DROP` cascades anyway).
  2. If you must rebuild a parent, DETACH every reference, swap, then
     REATTACH — snapshotting only the CASCADE children is NOT enough:
     - CASCADE children → snapshot whole rows, re-insert after.
     - SET NULL + nullable NO-ACTION refs → snapshot `(pk, fk)`, set
       them NULL before the swap, restore after.
     - NOT-NULL NO-ACTION children (e.g. `skills.created_by`) →
       snapshot the rows + their own CASCADE children, `DELETE` before
       the swap, restore after.
     Clear the CASCADE children EXPLICITLY (don't lean on the `DROP`'s
     cascade) so the migration behaves identically whether FK
     enforcement is on (D1) or off (some local runners) — otherwise
     the restore collides on a primary key. Parent ids are preserved,
     so the deferred check passes at COMMIT. `defer_foreign_keys=on`
     is valid inside a txn but only defers the *violation check* — it
     does NOT suppress the CASCADE/SET NULL *actions* and does NOT
     rescue the NO-ACTION case, so the detach is mandatory.
     `0028_idp_access.sql` is the worked example.
  3. Enumerate children from the LIVE schema (`SELECT name, sql FROM
     sqlite_master WHERE sql LIKE '%REFERENCES <table>%'`), classified
     by `ON DELETE` — do not trust a hand-written list in a comment
     (0013's comment both included a non-child, `usage_events`, and
     would have missed nothing only by luck).
  4. Test the rewrite on a throwaway D1 before it touches prod. D1's
     `/query` HTTP API reproduces the same FK-check-at-commit +
     auto-rollback as a real migration, so a seeded scratch DB tells
     you whether the rebuild actually preserves rows (and the
     auto-rollback means a botched rebuild fails closed, never
     half-applies).

### G2. Cloudflare Workers Assets

- **SPA fallback belongs to Assets, not Hono.** Set
  `not_found_handling = "single-page-application"` in `[assets]` and
  let the asset resolver serve `/index.html` for unknown non-API paths.
  A hand-rolled `app.notFound` that re-fetches `ASSETS` is fragile
  (Request body re-use, POST→/index.html→405, etc.) and unnecessary.
- **`run_worker_first` requires both bare + glob paths.** Routes like
  `/mcp` and `/mcp/*` must both appear, because the Worker may handle
  both the session-initiation request and per-session subpaths.
- **`apps/web/dist` must exist before `wrangler dev`/`deploy`.** A
  cold checkout has no dist directory. `scripts/ensure-dist.mjs` lays
  a placeholder `index.html`; `predev`/`prebuild`/`predeploy` hooks in
  `apps/worker/package.json` run it automatically.

### G3. Durable Objects

- **Storage backend is sticky.** Choosing `new_sqlite_classes` at first
  migration is irreversible — the class is permanently SQLite-backed.
  For stubs that don't use `ctx.storage.sql`, declare them under
  `new_classes`. Promote to SQLite in a later migration tag when SQL
  state actually lands.
- **First deploy is end-state, not history-replay.** The CF migration
  validator rejects two things that local dev tolerates:
  (1) `deleted_classes` + `new_sqlite_classes` for the same class in
  one migration tag (error 10021 — "class cannot be the target of more
  than one migration"); and (2) a `deleted_classes` referencing a
  class that wasn't exported in the previous deployed version (error
  10074). On a fresh account there IS no previous version — collapse
  any local backend-flip dance into a single migration that declares
  the end state. See ctxlayer's M2 closure: v1+v2+v3 (`new_classes`
  → `deleted_classes` → `new_sqlite_classes`) collapsed to one v1
  with `new_classes = ["DocRoomDO"]` + `new_sqlite_classes =
  ["McpSessionDO"]`.

### G4. Hono / Workers entry

- Type the entry as `ExportedHandler<Env>` so `queue` receives a typed
  `ctx: ExecutionContext` and `scheduled` receives a
  `ScheduledController` (not the legacy `ScheduledEvent`). Without
  `ctx`, queue consumers can't `waitUntil` post-ack work.
- **Queue dispatcher must handle unknown queue names.** Silently
  returning `undefined` drops the batch. Log + `msg.retry()` instead.
- **Consumers wrap each message in try/catch.** A poison message that
  throws before `ack()` stalls the whole batch. Until a dead-letter
  queue is configured, per-message `retry()` is the safety valve.

### G5. Bun

- **`packageManager` is pinned.** `bun@1.3.x` minimum. `engines.bun >=1.3`
  is advisory; the `packageManager` field is the hard gate.
- **`bun install --frozen-lockfile` does NOT fail on missing lockfile.**
  The SessionStart hook explicitly tests for `bun.lock` first and
  refuses to install otherwise.
- **`bun --filter='*' run <script>` silently skips workspaces missing
  the script.** Every workspace must declare stubs for `typecheck`,
  `lint`, `test` (even `echo 'no tests yet'`) so cross-cuts catch
  workspaces, not just whichever happened to have a real script.

### G6. Schemas and API boundaries

- **`.nullish()` for optional response fields.** `JSON.stringify` drops
  `undefined`, so a server that omits a nullable field would otherwise
  fail strict `.nullable()` parsing in the SPA. Use `.nullish()` (=
  `.nullable().optional()`).
- **Known-enum + open-string union for forward-compatible enums.**
  `KnownIdp = z.enum(['google','github'])` + `Idp = KnownIdp |
  z.string()` lets an OIDC provider land in M5 without breaking
  existing clients. Same pattern when adding values is plausible.
- **Distinguish HTTP failure from schema failure in fetch helpers.**
  `ApiError(status)` vs `ApiSchemaError(path, cause)`. Treating any
  failure as "not signed in" caused a redirect loop on schema drift;
  the SPA now surfaces parse errors as visible UI and only redirects
  on 401.

### G7. Wrangler CLI

- `wrangler versions upload` is the preview/staging command in wrangler
  4. The old `wrangler versions deploy --x-versions` flag was retired.
- D1/KV/Vectorize/R2 IDs in `wrangler.toml` are placeholder UUIDs
  (`00000000-…`). They're documented `<TODO>`s; runtime endpoints that
  touch the bindings return 503 (e.g. `/api/health`) until real IDs
  are populated.

### G8. SPA conventions

- **Sign-in buttons are gated on configured IdPs.** `/api/config`
  returns the list of providers whose env vars are set
  (`ALLOWED_GOOGLE_HD`, `ALLOWED_GITHUB_ORG`); the SPA renders only
  those buttons, with a clear "no IdPs configured" message when both
  are empty.
- **No anchors wrapping buttons.** Use `<button onClick={...}>` for
  actions; reserve `<a>` for in-app navigation.
- **All effects use `AbortController`.** Cleanup aborts in-flight
  fetches so StrictMode double-invokes and unmount races don't leak
  state.
- **Admin nav items always have matching routes.** Every admin page
  reachable from the sidebar is mounted in `app.tsx`. Before M5/M6
  shipped, the unimplemented ones rendered "coming in MN" stubs from
  `routes/admin/stubs.tsx`; that file is gone post-M6 — all admin
  pages are real now.

### G9. Smoke and seed scripts

- `scripts/seed.mjs` defaults to `--local`; `--remote` requires the
  explicit flag plus a 3-second abort window.
- `scripts/smoke.mjs` env-toggles expectations (`SMOKE_ME_OK=1` widens
  `/api/me` to `[200, 401]` for sessioned CI). New checks must declare
  realistic expected status sets — not `[200, 404]` "to be safe", which
  masks broken SPA dists.

### G10. Admin/UX guardrails to remember in M5

The full set of admin onboarding guardrails (visibility blast-radius
counter, "tags ≠ ACL" hint, first-time-setup banner) lives in
Section F9. Wire them in as the admin UI gets built.

### G11. Local HTTPS for dev (mkcert)

**Audience**: contributors hacking on this repo. Operators deploying
ctxlayer and end users of a deployed instance don't need mkcert —
Cloudflare's edge handles TLS for the public hostname.

The `__Host-` session cookie prefix requires `Secure`, which the
browser only honours over HTTPS. `wrangler dev` and `vite` both serve
HTTPS in dev, sharing a `mkcert`-generated cert in `.dev-tls/`
(gitignored).

- `scripts/setup-dev-tls.mjs` (idempotent, runs as `predev` on both
  worker and web). Checks `mkcert` is on PATH and prints install
  instructions if missing.
- `wrangler.toml` `[dev]` block: `local_protocol = "https"`,
  `https_key_path`/`https_cert_path` pointing into `.dev-tls/`.
- `apps/web/vite.config.ts`: reads the same cert + key into
  `server.https`; proxies use `target: 'https://localhost:8787'` with
  `secure: false` to trust the local CA.
- IdP redirect URIs in dev: `https://localhost:8787/idp/<idp>/callback`.
  Both Google and GitHub accept `localhost` as a valid redirect host.
- Prerequisite for new contributors: `brew install mkcert nss` (macOS)
  or the platform equivalent.

### G12. SPA session cookie shape

- Name: `__Host-ctx_session`. Attributes: `HttpOnly`, `Secure`,
  `SameSite=Lax`, `Path=/`, `Max-Age=2592000` (30d).
- Body: `<base64url(payload-json)>.<base64url(hmac-sha256)>`. Payload
  is `{ userId, role, iat, exp }` signed with
  `SESSION_COOKIE_SECRET` via WebCrypto.
- Verification is constant-time (`crypto.subtle.verify`).
- The OAuth redirect dance uses a sibling cookie
  `__Host-ctx_oauth_state` (TTL 10 min) carrying `{state, codeVerifier,
  returnTo, iat, exp}` so the callback can match state and exchange
  PKCE without server-side state storage.
- The MCP-client OAuth issuer (M2) will produce its own tokens via
  `workers-oauth-provider` — those tokens are independent of the SPA
  session cookie (separate lifecycles, separate signing keys).
