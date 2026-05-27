# M7a — Worker design (skills primitive)

> Implementation spec for the worker layer of [[H]]. Cites
> [[00-implementation-state]] for current patterns.
> Status: design, not yet implemented.

## Scope

- D1 schema for `skills`, `skill_revisions`, `skill_tags`,
  `skill_attachments`, `doc_attachments` (one migration: `0011_skills.sql`).
- Query layer (4 new files).
- REST namespace (4 new files): `/api/skills`, `/api/skill-attachments`,
  `/api/doc-attachments`, `/api/skills/export`.
- MCP additions to `session-do.ts`: `list_skills` + `get_skill` tools,
  `mcp://ctxlayer/skills/{slug}` resource template, `attached_skills`
  + `attached_docs` fields on `list_upstreams` / `list_my_context`,
  and on the per-tool catalogue.
- Shared DTOs (3 new files in `packages/shared/`).

Out of scope: admin SPA (M7b), CLI (M7c), drafting (M8), per-skill
read ACL (open-read by design).

## Schema (`0011_skills.sql`)

Mirrors the docs schema 1:1 in shape; differences called out below.

```sql
-- Skills: org-specific procedural playbooks. Open-read for any signed-in
-- user; admin-write. Status gates list_skills + MCP resource visibility
-- (only 'published' surfaces to non-admins).
CREATE TABLE skills (
  id              TEXT PRIMARY KEY,
  slug            TEXT NOT NULL UNIQUE,                  -- URL-safe id; also the SKILL.md `name:` value
  title           TEXT NOT NULL,                         -- human display label (SPA only)
  description     TEXT NOT NULL,                         -- when-to-use; also the SKILL.md `description:` value
  trigger_text    TEXT NOT NULL DEFAULT '',              -- optional extra "when X" hints
  status          TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','published','archived')),
  current_rev_id  TEXT,
  r2_snapshot     TEXT,                                  -- R2 key (filename), not URL
  created_by      TEXT NOT NULL REFERENCES users(id),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  deleted_at      INTEGER
);

CREATE INDEX idx_skills_status_updated
  ON skills(status, updated_at DESC)
  WHERE deleted_at IS NULL;

-- Revision history; mirrors doc_revisions exactly.
CREATE TABLE skill_revisions (
  id           TEXT PRIMARY KEY,
  skill_id     TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  author_id    TEXT REFERENCES users(id),
  r2_key       TEXT NOT NULL,
  byte_size    INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE INDEX idx_skill_revs_skill
  ON skill_revisions(skill_id, created_at DESC);

-- Tag filters; mirrors doc_tags exactly.
CREATE TABLE skill_tags (
  skill_id  TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  tag_kind  TEXT NOT NULL CHECK (tag_kind IN ('team', 'product', 'topic')),
  tag_value TEXT NOT NULL,
  PRIMARY KEY (skill_id, tag_kind, tag_value)
);

-- Skill ↔ upstream(.tool) attachments. tool_name='' = whole upstream.
-- '' sentinel + PK includes tool_name to comply with the D1 "no
-- expressions in PK" rule (no need for partial UNIQUE INDEX here
-- because '' is a legal PK component).
CREATE TABLE skill_attachments (
  skill_id     TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  upstream_id  TEXT NOT NULL REFERENCES upstream_servers(id) ON DELETE CASCADE,
  tool_name    TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  created_by   TEXT REFERENCES users(id),
  PRIMARY KEY (skill_id, upstream_id, tool_name)
);

CREATE INDEX idx_skill_attach_upstream
  ON skill_attachments(upstream_id, tool_name);

-- Doc ↔ upstream(.tool) attachments. Same shape as skill_attachments.
-- Lets reference docs ("Datadog naming conventions") surface alongside
-- procedural skills on the upstream's MCP listing.
CREATE TABLE doc_attachments (
  doc_id       TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  upstream_id  TEXT NOT NULL REFERENCES upstream_servers(id) ON DELETE CASCADE,
  tool_name    TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  created_by   TEXT REFERENCES users(id),
  PRIMARY KEY (doc_id, upstream_id, tool_name)
);

CREATE INDEX idx_doc_attach_upstream
  ON doc_attachments(upstream_id, tool_name);
```

**Design notes:**

- `name` column renamed to **`title`** — disambiguates from the
  SKILL.md `name:` frontmatter field (which maps from `slug`).
  Original H sketch said `name`; this is a small correction.
- No per-skill ACL table. Status (`draft` invisible to non-admins) is
  the only visibility lever beyond soft-delete + open-read.
- Attachments include `created_at` + `created_by` for audit trail; H
  didn't sketch these, added for parity with other audit-bearing
  tables.
- The `''` sentinel for `tool_name` participates in the PK directly
  (D1 rule: no expressions in PK; `''` is fine as a literal value).
- No `chunks_count` mirror — skills are not chunked into Vectorize.
  Defer to M11 if `search_skills` ever ships.

## Query layer

### `apps/worker/src/db/queries/skills.ts`

| Function | Purpose |
|---|---|
| `listSkills(env, { status?, tags? } = {})` | List non-deleted skills; default `status='published'`; tags AND-filter (optional). Returns `SkillSummary[]` ordered by `updated_at DESC`. |
| `listSkillsForAdmin(env, { status?, tags? } = {})` | Same but defaults to `status` ∈ `{draft, published}` and admin can request `'archived'` / `'all'`. |
| `getSkillById(env, id)` | Single `SkillDetail` with creator + latest-revision author joins, attachments, tags. Returns `null` if deleted or missing. |
| `getSkillBySlug(env, slug)` | Same, slug-keyed (used by MCP resource read). |
| `createSkill(env, input)` | UUID id, slug collision retry (3× random suffix on UNIQUE violation; same algorithm as `createDoc`). `status='draft'` default. |
| `patchSkill(env, id, patch)` | Patch `title`/`description`/`trigger_text`/`status`/`slug`. Bumps `updated_at`. Slug change re-runs collision retry. |
| `recordSkillRevision(env, input)` | Two-statement `env.DB.batch`: INSERT into `skill_revisions`, UPDATE `skills.current_rev_id + r2_snapshot + updated_at`. Mirrors `recordRevision` in `docs.ts`. |
| `listSkillRevisions(env, skillId)` | LIMIT 100, DESC by `created_at`. |
| `getSkillRevision(env, skillId, revisionId)` | Single revision row. |
| `softDeleteSkill(env, id)` | Sets `deleted_at`; never hard-deletes (revisions in R2 retained). |

### `apps/worker/src/db/queries/skill-attachments.ts`

| Function | Purpose |
|---|---|
| `listSkillAttachments(env, skillId)` | Returns `{ upstreamId, upstreamSlug, toolName }[]` (joins `upstream_servers` for slug). |
| `listAttachmentsForUpstream(env, upstreamId)` | Returns `{ skillId, slug, title, toolName }[]` — fueling `list_upstreams.attached_skills`. Filters out soft-deleted skills and non-published when caller is non-admin. |
| `attachSkill(env, { skillId, upstreamId, toolName, createdBy })` | INSERT; IGNORE on PK conflict (idempotent). `toolName` may be `''`. |
| `detachSkill(env, { skillId, upstreamId, toolName })` | DELETE by PK. |

### `apps/worker/src/db/queries/doc-attachments.ts`

Same shape, scoped to docs. Same four functions.

### `apps/worker/src/db/queries/skill-tags.ts`

| Function | Purpose |
|---|---|
| `listTagsForSkill(env, skillId)` | Returns `{ teams: string[], products: string[], topics: string[] }` (mirrors `listTagsForDoc`). |
| `replaceTagsForSkill(env, skillId, tags)` | DELETE all + INSERT new in batch. |

## REST namespaces

All routers use `route.use('*', requireCsrf)` (router-wide), not
per-route. Avoids the `admin-users.ts` foot-gun.

### `apps/worker/src/api/skills.ts` — `/api/skills`

| Method + path | Auth | Request | Response |
|---|---|---|---|
| `GET /` | requireUser | query: `?status=published\|all` (non-admin → forced to `published`), `?tag=team:eng`, `?q=substring` (optional) | `SkillSummary[]` |
| `GET /:slug` | requireUser | — | `SkillDetail` (404 if deleted / not published for non-admin) |
| `GET /:id/content` | requireUser | — | `DocContent` (BlockNote blocks JSON) read from R2 |
| `POST /` | requireAdmin + requireCsrf | `CreateSkillInput` (slug? title, description, trigger_text?, status?) | `SkillDetail` |
| `PATCH /:id` | requireAdmin + requireCsrf | `PatchSkillInput` (partial slug/title/description/trigger_text/status) | `SkillDetail` |
| `PUT /:id/content` | requireAdmin + requireCsrf | `DocContent` (BlockNote blocks) | `{ revisionId, byteSize }` |
| `DELETE /:id` | requireAdmin + requireCsrf | — | `204` |
| `GET /:id/revisions` | requireAdmin | — | `RevisionSummary[]` |
| `GET /:id/revisions/:revId` | requireAdmin | — | `DocContent` from R2 |

**Slug vs id**: `GET /:slug` uses slug because external (MCP, CLI)
references it; `PATCH/DELETE/PUT` use `id` because admin SPA holds it
internally. Same split as docs.

### `apps/worker/src/api/skill-attachments.ts` — `/api/skill-attachments`

| Method + path | Auth | Request | Response |
|---|---|---|---|
| `GET /?skillId=…` | requireUser | — | `SkillAttachment[]` |
| `POST /` | requireAdmin + requireCsrf | `{ skillId, upstreamId, toolName? }` | `204` |
| `DELETE /` | requireAdmin + requireCsrf | `{ skillId, upstreamId, toolName? }` (body or query) | `204` |

### `apps/worker/src/api/doc-attachments.ts` — `/api/doc-attachments`

Same shape, scoped to docs.

### `apps/worker/src/api/skills-export.ts` — `/api/skills/export`

| Method + path | Auth | Response |
|---|---|---|
| `GET /` | requireUser | `{ slug, name (=slug), description, body_md }[]` — published only, body rendered to markdown via `renderBlocksToMarkdown` |

Used by `ctxlayer pull` (M7c). `name` field in the response is the
slug for direct Claude Code SKILL.md frontmatter consumption — CLI
emits it verbatim. Body is materialised to markdown server-side so the
CLI doesn't need a BlockNote renderer.

### Mount in `apps/worker/src/index.ts`

```ts
import { skillsRoute } from './api/skills';
import { skillAttachmentsRoute } from './api/skill-attachments';
import { docAttachmentsRoute } from './api/doc-attachments';
import { skillsExportRoute } from './api/skills-export';

// alongside the existing app.route(...) calls:
app.route('/api/skills/export', skillsExportRoute);   // mount FIRST (more specific)
app.route('/api/skills', skillsRoute);
app.route('/api/skill-attachments', skillAttachmentsRoute);
app.route('/api/doc-attachments', docAttachmentsRoute);
```

`/export` mounted before `/api/skills` so `:slug` doesn't shadow it.

## MCP surface

All edits in `apps/worker/src/mcp/session-do.ts`. The doc resource
template registration at lines 242-305 is the structural model.

### 1. `list_skills` tool

```ts
server.registerTool(
  'list_skills',
  {
    description: 'List org skills (procedural playbooks). Defaults to ' +
                 'published; non-admins see only published.',
    inputSchema: {
      scope: z.union([
        z.literal('all'),
        z.object({ teams: z.array(z.string()).optional(),
                   products: z.array(z.string()).optional() }),
      ]).optional(),
    },
  },
  rec('list_skills', async (input) => {
    if (!userId) return errText('not_signed_in');
    const skills = await listSkills(env, { status: 'published' });
    const filtered = scopeFilter(skills, input?.scope, await resolveUserScope(env, userId));
    return jsonText(filtered.map(s => ({
      slug: s.slug,
      name: s.title,                         // human display label
      description: s.description,
      attached_to: s.attachments.map(a => ({
        upstream_slug: a.upstreamSlug,
        tool_name: a.toolName || null,
      })),
    })));
  }),
);
```

Tag-based scope filter reuses `resolveUserScope` from `doc-tags.ts`.
Skills with no tags pass any scope filter (open by default).

### 2. `get_skill` tool

```ts
server.registerTool(
  'get_skill',
  {
    description: 'Fetch a skill body by slug. Returns markdown.',
    inputSchema: { slug: z.string().min(1) },
  },
  rec('get_skill', async ({ slug }) => {
    const skill = await getSkillBySlug(env, slug);
    if (!skill || skill.status !== 'published') return errText('not_found');
    const blocks = await readSnapshot(env, skill.r2Snapshot);
    return text(renderBlocksToMarkdown(blocks));
  }),
);
```

Convenience companion to the resource template; H lists both.

### 3. Resource template `mcp://ctxlayer/skills/{slug}`

```ts
const skillTemplate = new ResourceTemplate('mcp://ctxlayer/skills/{slug}', {
  list: async () => {
    const skills = await listSkills(env, { status: 'published' });
    return { resources: skills.map(s => ({
      uri: `mcp://ctxlayer/skills/${s.slug}`,
      name: s.title,
      description: s.description,
      mimeType: 'text/markdown',
    })) };
  },
});

server.registerResource(
  'skill',
  skillTemplate,
  { name: 'Skill', mimeType: 'text/markdown' },
  async (uri, vars) => {
    const skill = await getSkillBySlug(env, vars.slug);
    if (!skill || skill.status !== 'published') {
      throw new Error('not_found');
    }
    const blocks = await readSnapshot(env, skill.r2Snapshot);
    return { contents: [{
      uri: uri.href,
      mimeType: 'text/markdown',
      text: renderBlocksToMarkdown(blocks),
    }] };
  },
);
```

### 4. Extend `list_upstreams` and `list_my_context` payloads

`mcp/tools-proxy.ts` builds `ListUpstreamsEntry`. Extend to embed
whole-upstream attachments:

```ts
type ListUpstreamsEntry = {
  slug: string;
  displayName: string;
  transport: 'http' | 'sse';
  connected: boolean;
  toolsCount: number;
  requiresAuth: boolean;
  attached_skills: Array<{ slug: string; name: string }>;  // NEW
  attached_docs: Array<{ slug: string; title: string }>;   // NEW
};
```

Population: single batch query in `tools-proxy.ts` builder using
`listAttachmentsForUpstream(env, upstreamId)` filtered to
`toolName=''`. Non-admin sessions filter out non-published skills.

`list_my_context` returns an `accessibleUpstreams` array — same
extension applies.

### 5. Per-tool catalogue extension

`/api/upstreams/:id/tools` (user-side) and the admin equivalent
`/api/admin/upstreams/:id/tools` already return cached tool rows.
Extend each row:

```ts
type UpstreamTool = {
  toolName: string;
  description: string | null;
  inputSchema: unknown;
  attached_skills: Array<{ slug: string; name: string }>;   // NEW
  attached_docs: Array<{ slug: string; title: string }>;    // NEW
};
```

Population: `listAttachmentsForUpstream(env, upstreamId)` once →
group-by `toolName` → join into the tools list. Filter non-published
for non-admins.

## File inventory

### New files

```
apps/worker/src/db/migrations/0011_skills.sql
apps/worker/src/db/queries/skills.ts
apps/worker/src/db/queries/skill-attachments.ts
apps/worker/src/db/queries/skill-tags.ts
apps/worker/src/db/queries/doc-attachments.ts
apps/worker/src/api/skills.ts
apps/worker/src/api/skill-attachments.ts
apps/worker/src/api/doc-attachments.ts
apps/worker/src/api/skills-export.ts
apps/worker/src/mcp/skill-resource.ts            (factored from session-do.ts if it grows past ~350 lines)
packages/shared/src/skills-types.ts
packages/shared/src/skill-attachment-types.ts
packages/shared/src/doc-attachment-types.ts
```

### Modified files

```
apps/worker/src/index.ts                    — mount 4 new routes
apps/worker/src/mcp/session-do.ts           — register list_skills + get_skill + skill resource template + extend list_upstreams/list_my_context payloads
apps/worker/src/mcp/tools-proxy.ts          — extend ListUpstreamsEntry shape; pull attached_*
apps/worker/src/api/upstreams.ts            — extend GET /api/upstreams/:id/tools rows
apps/worker/src/api/admin-upstreams.ts      — extend admin variant
packages/shared/src/upstream-api.ts         — extend ListUpstreams + UpstreamToolsResponse DTOs
packages/shared/src/index.ts                — re-export new types
```

## Shared DTOs

`packages/shared/src/skills-types.ts`:

```ts
export const SkillStatus = z.enum(['draft', 'published', 'archived']);
export type SkillStatus = z.infer<typeof SkillStatus>;

export const SkillSlug = z.string().min(1).max(64)
  .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);                 // SKILL.md-safe

export const SkillSummary = z.object({
  id: z.string(),
  slug: SkillSlug,
  title: z.string(),
  description: z.string(),
  status: SkillStatus,
  updatedAt: z.number(),
  createdBy: UserSummary.nullable(),
});

export const SkillDetail = SkillSummary.extend({
  triggerText: z.string(),
  currentRevId: z.string().nullable(),
  r2Snapshot: z.string().nullable(),
  attachments: z.array(SkillAttachmentRef),               // upstream+tool list
  tags: TagBag,                                           // { teams, products, topics }
  createdAt: z.number(),
});

export const CreateSkillInput = z.object({
  slug: SkillSlug.optional(),                              // auto-generate if absent
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(500),
  triggerText: z.string().max(500).optional(),
  status: SkillStatus.optional(),                          // default 'draft'
});

export const PatchSkillInput = CreateSkillInput.partial();
```

`packages/shared/src/skill-attachment-types.ts` and
`doc-attachment-types.ts` define `{skillId, upstreamId, toolName}`
shapes plus the join-side `{upstreamSlug, toolName}` ref.

`packages/shared/src/upstream-api.ts` extension:

```ts
export const AttachedSkillRef = z.object({ slug: z.string(), name: z.string() });
export const AttachedDocRef = z.object({ slug: z.string(), title: z.string() });

// extend existing ListUpstreamsEntry + UpstreamToolsResponse schemas
// by .extend({ attachedSkills: z.array(AttachedSkillRef), attachedDocs: z.array(AttachedDocRef) })
```

## Verification

In rough order, each step is an independent gate:

1. **Migration applies clean.**
   - `bun run migrate:local` → no error, fresh tables exist
     (`bunx wrangler d1 execute DB --local --command="PRAGMA table_info(skills)"`).
   - `bun run migrate:remote` → applies on workers.dev D1.
2. **Round-trip via REST (admin token):**
   ```
   POST /api/skills { title, description, slug } → 200 SkillDetail
   PUT  /api/skills/:id/content { blocks: [...] } → 200 {revisionId, byteSize}
   GET  /api/skills/:slug → 200 SkillDetail (current_rev_id set)
   GET  /api/skills/:id/content → 200 DocContent
   PATCH /api/skills/:id { status: 'published' } → 200
   GET  /api/skills (non-admin) → includes the skill
   DELETE /api/skills/:id → 204; subsequent GET → 404
   ```
3. **Attachments round-trip:**
   ```
   POST /api/skill-attachments { skillId, upstreamId, toolName: 'create_issue' } → 204
   GET  /api/upstreams/:id/tools → tool row carries attached_skills
   GET  /api/admin/upstreams → upstream row carries attached_skills (whole-upstream when toolName='')
   ```
4. **MCP via Claude.ai (deploy first):**
   - `list_skills` returns published, hides drafts.
   - `mcp://ctxlayer/skills/<slug>` `list()` enumerates published, read
     returns markdown body.
   - `get_skill { slug }` returns body.
   - `list_upstreams` shows `attached_skills` on the right upstream.
   - `list_my_context.accessibleUpstreams[].attached_skills` also
     populated.
5. **Open-read invariant:** sign in as a non-admin user; verify
   GET /api/skills returns the published skill, GET on draft returns
   404 (not 403), and MCP `list_skills` doesn't expose draft.
6. **/smoke passes.** All existing endpoints still 200; new skills
   endpoints added to smoke script.
7. **Security pass invariants hold:**
   - No new token-body logs (all skill endpoints use generic error
     messages).
   - `requireCsrf` is router-wide on all 4 new routers.
   - Upstream tool descriptions still sanitised when surfaced via
     the per-tool extension.

## Sequencing within M7a

A natural commit order that keeps the worker building cleanly at each
step:

1. **Schema + queries** — migration + 4 query files + DTOs. No
   integration yet. Add a tiny unit test per query file (`*.test.ts`)
   stubbing `env.DB` to confirm SQL parses and result shapes parse.
2. **REST routes + mount** — 4 api files + index.ts mount. Smoke via
   curl with `.dev.vars`-supplied admin session cookie.
3. **MCP additions** — register `list_skills` + `get_skill` + resource
   template in `session-do.ts`. `list_upstreams` extension last (it
   touches the upstream-proxy code path, riskier than additive tools).
4. **Per-tool catalogue extension** — extend GET
   `/api/upstreams/:id/tools` + admin variant. Touches two existing
   endpoints; bundle into a single commit with the DTO extension so
   the SPA's typecheck doesn't break in between.

Each step is independently deployable and verifiable.

## Risks called out

- **`list_upstreams` shape change** breaks any existing MCP client
  that strictly validates the response. Mitigation: add fields as
  optional in the Zod schema; old clients ignore them. Both
  `attached_skills` and `attached_docs` default to `[]` when no
  attachments exist (don't omit the key).
- **R2 snapshot pattern** — skills reuse `DOCS_BUCKET` for now (R2
  keys prefixed `skills/<id>/<rev>.json`). Alternative would be a
  separate bucket; not worth the operational extra. Confirm during
  implementation: existing R2 helpers in `apps/worker/src/storage/r2.ts`
  (or wherever doc snapshots land) take an arbitrary key prefix.
- **Slug validation** — must be SKILL.md-safe (lowercase, hyphens
  only, no leading/trailing hyphen). Stricter than doc slugs. Enforce
  in Zod schema + worker-side `createSkill`.
- **Order of mount** — `/api/skills/export` must mount before
  `/api/skills` (more specific first) or Hono will treat `export` as
  a `:slug` value.

## What stays for M7b / M7c / M8

- **M7b**: admin/skills SPA page, per-skill editor (reuses BlockNote
  shell), attach UI widget on upstream detail page, copy-command
  helper for "draft this skill via CLI".
- **M7c**: `packages/cli/` workspace with `login` (DCR + loopback
  PKCE), `pull` (reads `/api/skills/export`), optional `watch`.
- **M8**: `/api/skills/draft-context` endpoint, catalogue diff +
  staleness flag, `ctxlayer draft-skill` CLI command, schema-reference
  linter on `POST /api/skills`.
