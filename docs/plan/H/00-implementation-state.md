# H — Implementation state snapshot (2026-05-27)

> Synthesised from 3 parallel Explore passes the day H was committed.
> Used by the per-milestone design docs (`M7a.md`, `M7b.md`, `M7c.md`,
> `M8.md`) — they cite this rather than re-discovering state. If a
> session opens M7 weeks later, re-run a quick Explore pass before
> trusting these line refs; the rest (schemas, patterns, conventions)
> drifts slowly.

## Greenfield confirmation

`grep -ri skill apps/worker/src apps/web/src packages/shared/src` → zero
matches. **Nothing skill-related exists today.** No migration, no
queries, no MCP registration, no SPA route, no DTO. H is fully
additive — no rewrites, no backwards-compatibility surface.

## Migration sequence (correct numbering)

Actual files under `apps/worker/src/db/migrations/`:

| File | Purpose |
|---|---|
| `0001_init.sql` | users, upstream_servers, upstream_tools, user_credentials, audit_log, usage_events (the unused sandbox-sessions table is dropped by migration `0013`) |
| `0002_docs.sql` | documents, doc_revisions |
| `0003_usage.sql` | usage_rollups_daily |
| `0004_org_ia.sql` | teams, products, team_members, team_products, upstream_visibility, doc_tags |
| `0005_doc_acl.sql` | doc_editors |
| `0006_doc_chunk_count.sql` | ADD COLUMN doc_chunks |
| `0007_shared_credentials.sql` | ALTER upstream_servers auth_config |
| `0008_doc_folders.sql` | ADD COLUMN documents.folder |
| `0009_doc_locks.sql` | ADD COLUMNS documents.locked_at, locked_by |
| `0010_team_managed_by_idp.sql` | ALTER teams.idp_group |

**Next slot is `0011_skills.sql`.** H originally said `0008`; corrected.

## Patterns to mirror (with file refs)

### Docs schema → skills schema

`documents` at `apps/worker/src/db/migrations/0002_docs.sql:3-14`:

```sql
CREATE TABLE documents (
  id             TEXT PRIMARY KEY,
  title          TEXT NOT NULL,
  slug           TEXT NOT NULL UNIQUE,
  kind           TEXT NOT NULL DEFAULT 'doc' CHECK (kind IN ('doc', 'prompt')),
  current_rev_id TEXT,
  r2_snapshot    TEXT,
  created_by     TEXT REFERENCES users(id),
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  deleted_at     INTEGER
);
```

`doc_revisions` at `0002_docs.sql:17-25` — exact shape to copy.
`doc_tags` at `0004_org_ia.sql:59-64` — `tag_kind ∈ team|product|topic`
enforced by CHECK; PK `(doc_id, tag_kind, tag_value)`.

### Docs queries → skills queries

`apps/worker/src/db/queries/docs.ts` (~514 lines) — pattern reference:

- `listDocs(env)`, `getDocById(env, id)`, `createDoc(env, input)`,
  `patchDoc(env, id, patch)`, `softDeleteDoc(env, id)`.
- `recordRevision(env, input)` — two-statement batch: INSERT into
  `doc_revisions`, UPDATE `documents.current_rev_id + r2_snapshot +
  updated_at`. Skills will mirror exactly.
- `listRevisions(env, docId)` LIMIT 100, `getRevision(env, docId,
  revId)`.
- Slug collision retry: 3× attempts with random suffix on UNIQUE
  violation.
- Soft-delete pattern: every read filters `WHERE deleted_at IS NULL`.

ACL helpers (`canEditDoc`, `canShareDoc`, `canLockDoc`,
`editGateReason`) — **do NOT mirror for skills**. Skills are
open-read + admin-write per H; no per-skill ACL.

### MCP registration → skills MCP registration

`apps/worker/src/mcp/session-do.ts` registers (lines confirmed via Explore):

- `whoami` 85-95 — schema-less, returns `this.props`.
- `list_my_context` 97-130 — schema-less, returns scope summary.
- `list_upstreams` 132-148 — schema-less, returns `ListUpstreamsEntry[]`.
- `get_doc` 150-173 — `{id: z.string()}`, returns markdown.
- `search_docs` 175-235 — `{query, k?, scope?}`, scope-post-filtered.

Doc resource template registration (242-305):

```ts
const template = new ResourceTemplate('mcp://ctxlayer/docs/{id}', {
  list: async () => {
    const docs = await listDocs(env);
    return { resources: docs.map(d => ({
      uri: `mcp://ctxlayer/docs/${d.id}`,
      name: d.title,
      description: d.slug,
      mimeType: 'text/markdown',
    })) };
  },
});
server.registerResource('doc', template, { … }, async (uri, vars) => {
  const doc = await getDocById(env, vars.id);
  const snapshot = await readSnapshot(env, doc.r2_snapshot);
  return { contents: [{ uri: uri.href, mimeType: 'text/markdown',
                        text: renderBlocksToMarkdown(snapshot.blocks) }] };
});
```

Skills mirror this pattern at `mcp://ctxlayer/skills/{slug}` (note:
slug, not id — per H).

### `list_upstreams` extension

`ListUpstreamsEntry` shape in `apps/worker/src/mcp/tools-proxy.ts:45-52`:

```ts
{ slug, displayName, transport, connected, toolsCount, requiresAuth }
```

No `attached_skills` or `attached_docs` field yet. Extension is a real
shape change to both the worker type and the `@ctxlayer/shared` DTO.

### REST namespace pattern

`apps/worker/src/api/*.ts` — 20 files. Admin pattern (e.g.
`admin-users.ts`, `admin-upstreams.ts`):

```ts
const route = new Hono<{ Bindings: Env; Variables: AuthedVariables }>();
route.use('*', requireAdmin);                  // router-wide auth
route.use('*', requireCsrf);                   // router-wide CSRF (most files)
// OR per-route: route.patch('/:id', requireCsrf, async (c) => …)
```

**Per-route CSRF gotcha (from CLAUDE.md)**: `admin-users.ts` applies
`requireCsrf` per-route (not router-wide) — a regression risk if
copy-pasting. New skills router should use router-wide
`route.use('*', requireCsrf)` like `admin-teams.ts` does.

Mount pattern in `apps/worker/src/index.ts`:

```ts
app.route('/api/skills', skillsRoute);
app.route('/api/skills', skillAttachmentsRoute);   // disjoint subpaths OK
app.route('/api/admin/skills', adminSkillsRoute);  // admin-gated variant
```

### Auth/CSRF middleware

- `requireUser` / `requireAdmin` at `apps/worker/src/auth/middleware.ts`.
- `requireCsrf` at `apps/worker/src/auth/csrf.ts` — double-submit cookie
  + Origin check via `util/origin.ts`. Passes through safe methods.

### Upstream tools cache

`upstream_tools` schema at `0001_init.sql:29-36`:

```sql
CREATE TABLE upstream_tools (
  upstream_id   TEXT NOT NULL REFERENCES upstream_servers(id) ON DELETE CASCADE,
  tool_name     TEXT NOT NULL,
  description   TEXT,
  input_schema  TEXT NOT NULL,
  cached_at     INTEGER NOT NULL,
  PRIMARY KEY (upstream_id, tool_name)
);
```

TTL check at `apps/worker/src/mcp/tools-proxy.ts:42-43,155`. Refresh
path: `replaceCachedTools()` at `db/queries/upstreams.ts:332-351`,
called by `refreshCatalogueForConnection()` at
`upstream/catalogue.ts:60-82`. **M8 catalogue diff hooks here.**

### SPA admin page template

`apps/web/src/routes/admin/users.tsx` is the closest template for
`admin/skills.tsx`:

- Fetch on mount with `AbortController` + `reload()` callback.
- Plain `<table class="data-table">` with row click → `setEditingId()`.
- Right `Drawer` for edit; sub-components: `Section` / `KV` helpers
  (lines 288-340 of users.tsx).
- Mutations via `withBusy()` helper, inline `fetch` via `api.ts`.
- **Off-pattern**: uses native `confirm()` at line 193. New code must
  use `dialogs.confirm/prompt/alert` from `apps/web/src/lib/dialogs.tsx`
  (per CLAUDE.md "Mantine modals via lib/dialogs.tsx").

### Doc editor → skills editor

`apps/web/src/routes/docs-editor.tsx` (825 lines) is the most complex
SPA route. Skills get a simpler version (no collab, no folder UI, no
locks). Reusable pieces:

- `apps/web/src/components/editor/blocknote-editor.tsx` — forwardRef
  wrapper. Takes `initialBlocks` + `editable` + optional
  `collaboration`. Skills can use without `collaboration` for
  single-writer simplicity (M7b).
- Autosave constants from docs-editor.tsx:51-53: `SAVE_IDLE_MS=5000`,
  `SAVE_MAX_MS=30000`. Skills can reuse, or use a simpler save-on-
  blur for v1.

### API client (`apps/web/src/lib/api.ts`)

`request<T>(path, parser, init)` helper:

- CSRF token auto-injected on unsafe methods (`X-CSRF` header from
  `__Host-ctx_csrf` cookie).
- Errors: `ApiError` (HTTP non-2xx) vs `ApiSchemaError` (Zod parse
  fail). **Don't conflate them** (per CLAUDE.md).
- Patterns: `fetchDocs(signal)`, `createDoc(input)`, `patchDoc(id,
  patch)`, `putDocContent(id, content)`. Skills mirror exactly with
  `fetchSkills` / `createSkill` / `patchSkill` / `putSkillContent` /
  `attachSkill` / `detachSkill` etc.

### Shared DTOs

`packages/shared/src/`:

- `docs-types.ts` defines `DocKind`, `DocContent`, `DocSlug`,
  `FolderPath`, `UserSummary`, `DocSummary`, `DocDetail`. Mirror as
  `skills-types.ts` with `SkillSummary`, `SkillDetail`, `SkillStatus`
  ∈ `draft|published|archived`, plus attachment DTOs.
- Workspace stubs pattern (every workspace): `typecheck` / `lint` /
  `test` scripts even if no-op (per CLAUDE.md). `packages/cli/` must
  add the same stubs.

### Packages layout for CLI

`packages/` contains only `shared/`. Root `package.json` workspaces
glob is `["apps/*", "packages/*"]` → adding `packages/cli/` is
plug-and-play, no root config change.

`packages/shared/tsconfig.json` extends `../../tsconfig.base.json` with
no `paths` / `references`. The web app's `tsconfig.json` aliases
`@ctxlayer/shared` → `../../packages/shared/src`. CLI tsconfig follows
the same shape.

## D1 / SQLite gotchas to obey (from G-conventions.md)

- **No expressions in PK.** Use `''` sentinel + partial `UNIQUE INDEX
  WHERE col = sentinel` for "at most one nullable-value row".
- **Every enum-shaped column** has a matching `CHECK (col IN (…))`.
- **No D1 transactions** — use `env.DB.batch()` for atomicity.
- **R2 snapshot stored as filename**, not URL. Populate in same statement
  as `recordRevision`.
- **Soft delete** via nullable `deleted_at INTEGER`; reads filter
  `WHERE deleted_at IS NULL`.

## OAuth provider for CLI

`apps/worker/src/oauth/provider-config.ts:1-40` — single source for
`oauthProviderOptions()` used by both live provider and admin OAuth
client viewer. M7c CLI registers via DCR (`POST /oauth/register`) at
runtime — no static config change needed. Loopback PKCE on
`http://127.0.0.1:<random>/cb`, token bundle persisted to file (see
[[M7c]]).

## Hono mount in `apps/worker/src/index.ts`

```ts
const app = new Hono<{ Bindings: Env }>();
app.route('/api/health', healthRoute);
app.route('/api/me', meRoute);
app.route('/api/docs', docsRoute);
// …
app.route('/api/admin/teams', adminTeamsRoute);
```

New mounts for M7a (additive only):

```ts
app.route('/api/skills', skillsRoute);                 // user-read + admin-write
app.route('/api/skill-attachments', skillAttachmentsRoute);
app.route('/api/doc-attachments', docAttachmentsRoute);
app.route('/api/skills/export', skillsExportRoute);    // M7c CLI pull endpoint
```

## What's not in scope for the design docs

- **M9+** is content milestones (connector kits) — H covers; nothing
  to design here.
- **M11** (search over skills) — deferred behind real-volume signal.
- **Stdio upstreams** — bring-your-own-bridge (register an operator-run stdio↔HTTP bridge as a `streamable_http` upstream); no ctxlayer-managed sandboxes. Unrelated to skills work.
