# Org information architecture — teams, products, and access

Each ctxlayer deployment is **a separate install for one org**. Inside the
org we model two orthogonal groupings:

- **Teams** — who people belong to (`platform`, `web-frontend`, `infra`).
- **Products** — what the org delivers (`checkout`, `search`, `billing`).
- Teams are assigned to products (many-to-many). Users belong to teams
  (many-to-many). Product membership is transitive through team.

Defaults are tuned to **spread context, gate execution**:

| Surface | Default | Centrally controlled |
|---|---|---|
| Docs | Open-read for everyone signed in. | Admins manage tags; tags drive filtering, not access. |
| MCP upstreams | New upstreams visible to **no one**. | Admins grant per team or per product. |
| `search_docs` | Filters to user's teams ∪ products ∪ untagged "global" docs. | `scope:'all'` overrides. |
| `list_upstreams` | Returns only what the user can use. | (No escape hatch — that IS the access list.) |

### F1. Data model additions (`0004_org_ia.sql`)

```sql
CREATE TABLE teams (
  id           TEXT PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  description  TEXT,
  -- Reserved for future IdP sync: 'google:<group-email>' | 'github:<org>/<team-slug>'.
  -- The string is stored + surfaced in the admin UI today (post-M6); the
  -- sync logic that consumes it isn't implemented yet — manual membership
  -- is still authoritative until then. See `managed_by_idp` (migration
  -- 0010_team_managed_by_idp.sql).
  idp_group    TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE products (
  id           TEXT PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  description  TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE team_members (
  team_id    TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'member',   -- 'member' | 'lead'
  created_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX idx_team_members_user ON team_members(user_id);

CREATE TABLE team_products (
  team_id    TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  PRIMARY KEY (team_id, product_id)
);
CREATE INDEX idx_team_products_product ON team_products(product_id);

-- Visibility scope for upstream MCP servers. Additive: a user has access
-- if ANY row matches. New upstreams have zero rows → invisible until an
-- admin grants.
CREATE TABLE upstream_visibility (
  upstream_id TEXT NOT NULL REFERENCES upstream_servers(id) ON DELETE CASCADE,
  scope_kind  TEXT NOT NULL,                  -- 'everyone' | 'team' | 'product'
  scope_id    TEXT,                           -- team_id | product_id | NULL for 'everyone'
  PRIMARY KEY (upstream_id, scope_kind, COALESCE(scope_id, ''))
);

-- Tags on documents. Used for filtering / shaping default agent context.
-- Does NOT gate read access — every signed-in user can read every
-- non-deleted document.
CREATE TABLE doc_tags (
  doc_id    TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  tag_kind  TEXT NOT NULL,                    -- 'team' | 'product' | 'topic'
  tag_value TEXT NOT NULL,                    -- team_id | product_id | free-form topic slug
  PRIMARY KEY (doc_id, tag_kind, tag_value)
);
CREATE INDEX idx_doc_tags_lookup ON doc_tags(tag_kind, tag_value);
```

### F2. Access resolution

The single query backing `tools/list` filtering and the admin "which
upstreams can this user see" view:

```sql
SELECT DISTINCT us.*
FROM upstream_servers us
JOIN upstream_visibility uv ON uv.upstream_id = us.id
WHERE us.enabled = 1
  AND (
    uv.scope_kind = 'everyone'
    OR (uv.scope_kind = 'team'
        AND uv.scope_id IN (SELECT team_id FROM team_members WHERE user_id = ?))
    OR (uv.scope_kind = 'product'
        AND uv.scope_id IN (
          SELECT tp.product_id
          FROM team_products tp
          JOIN team_members tm ON tm.team_id = tp.team_id
          WHERE tm.user_id = ?
        ))
  );
```

The same predicate, in TS, lives in `apps/worker/src/db/queries/access.ts`
so route handlers and the MCP layer share one source of truth.

### F3. Search default scope

When the agent calls `search_docs({query, k, scope?})`:

- **omitted** — build a Vectorize metadata filter:
  `tag_team IN user_teams OR tag_product IN user_products OR is_global=true`.
  "Global" = a doc with zero team/product tags (it may still have topic
  tags). Untagged docs are everyone's by design.
- **`scope: 'all'`** — drop the filter.
- **`scope: { teams?: [...], products?: [...] }`** — explicit; intersected
  with what the user belongs to so an agent can't elevate.

Chunk metadata stored in Vectorize when (re)indexing a doc:
`{ docId, chunkIdx, revisionId, title, tag_teams: [team_id, ...], tag_products: [...], is_global: bool }`.

### F4. New + changed built-in MCP tools

- `list_upstreams()` — unchanged shape; already user-scoped via F2.
- `search_docs(query, k, scope?)` — adds the optional `scope` arg per F3.
  Each result also carries the doc's tags so the agent can cite scope.
- **New** `list_my_context()` →
  `{ teams: [{slug, displayName, role}], products: [{slug, displayName}], accessibleUpstreams: [slug, ...], defaultScope: {teams: [...], products: [...]} }`.
  Cheap, no upstream calls. Helps an agent self-orient at session start.

### F5. Admin UI additions

- **`/app/admin/teams`** — CRUD; row → drawer with member table
  (add/remove users by email; role: member|lead). Editable
  `idp_group` field + `managed_by_idp` checkbox surface the SSO/group-sync
  prep — the sync logic that consumes them isn't shipped yet, but admins
  can record intent now so migration to managed teams is one-step when
  sync lands.
- **`/app/admin/products`** — CRUD (slug, display_name, description).
- **`/app/admin/team-products`** — a teams×products matrix with checkbox
  cells; one save per change (`PATCH /api/admin/team-products`).
- **`/app/admin/upstreams`** edit form — new "Visibility" section:
  radio `Everyone | Specific teams | Specific products | Combination`,
  multi-selects revealed by the choice. Combinations are additive.
  Default on create: empty → invisible until granted. The form shows a
  live "users with access: N" counter before save.
- **`/app/admin/docs`** and `/app/docs/:id` editor — tag editor pane:
  team multi-select, product multi-select, free-form topic-tag chips.

### F6. REST endpoints (additions to D5)

```
GET    /api/me/context                 -> { teams, products, accessibleUpstreams }
GET    /api/teams                      -> [{ id, slug, displayName }]      (public org-wide)
GET    /api/products                   -> [{ id, slug, displayName }]      (public org-wide)
GET    /api/docs/:id/tags              -> { teams:[...], products:[...], topics:[...] }
PUT    /api/docs/:id/tags              -> body: same shape                  (author + admin)

GET    /api/admin/teams
POST   /api/admin/teams                -> { slug, displayName, description?, idpGroup? }
PATCH  /api/admin/teams/:id
DELETE /api/admin/teams/:id
GET    /api/admin/teams/:id/members
POST   /api/admin/teams/:id/members    -> { userId, role? }
DELETE /api/admin/teams/:id/members/:userId

GET    /api/admin/products
POST   /api/admin/products
PATCH  /api/admin/products/:id
DELETE /api/admin/products/:id

GET    /api/admin/team-products        -> [{ teamId, productId }]
PUT    /api/admin/team-products        -> { adds:[...], removes:[...] }

GET    /api/admin/upstreams/:id/visibility -> [{ scopeKind, scopeId }]
PUT    /api/admin/upstreams/:id/visibility -> { rules:[...] }               (admin replaces full set)
```

All in `packages/shared/src/api-types.ts` with Zod schemas; SPA's typed
`api.ts` consumes the same shapes.

### F7. Milestone impact

- **M1** (+~0.5 day): ship migration `0004_org_ia.sql` alongside
  `0001`–`0003`. Empty `teams`/`products` tables. SPA admin pages can
  render with "no teams yet" copy.
- **M2**: persist tag metadata into Vectorize during reindex. Tag editor
  pane in the doc editor. `search_docs` honours `scope`.
- **M4**: `upstream_visibility` enforced in `tools/list` aggregation
  (Section C1). Admin REST writes the visibility rules.
- **M5**: full admin UI for teams / products / team-products / visibility
  editor on the upstream form.

### F8. Future IdP sync (not in v1)

When we enable it later:

- `teams.idp_group` formats:
  - `google:<group-email@acme.com>` — needs Google Workspace Directory API
    `groups.list` + `members.list`; admin-consented scope
    `admin.directory.group.member.readonly`.
  - `github:<org>/<team-slug>` — needs the `read:org` GitHub scope at
    sign-in.
- Sync runs:
  - On each sign-in for the calling user (just their groups; fast).
  - Nightly cron for full reconciliation across all `idp_group`-bound teams.
- Direction: IdP → ctxlayer. Memberships added manually remain unless the
  team is flipped to `managed_by_idp = true` (column shipped in migration
  0010 post-M6; toggleable from `/app/admin/teams`). The flag is currently
  intent-only — no sync job consumes it yet.

### F9. UX guardrails

- Doc editor's tag pane carries a one-line hint: "Tags help people and
  agents find this doc. Anyone in the org can still read it." — to
  prevent the confusion that tags == ACL.
- The admin upstream-visibility editor shows a live "users with access:
  N" counter so the admin sees the blast radius before saving.
- `list_my_context()` is documented in the MCP setup page so agent authors
  know to call it once at session start.

### F10. Risks

- **Discoverability vs. relevance** — over-aggressive default filtering
  can hide useful org-wide context. Mitigation: untagged docs are always
  included; `scope:'all'` is one keyword away; admin dashboards show
  per-tag doc counts so curators see imbalance.
- **Tag drift** — free-form topic tags will multiply. Admin "Topic tags"
  page with rename/merge tools (M5+).
- **Admin onboarding gap** — fresh install has no teams/products and no
  upstream visibility, so no user sees any proxied tools until setup is
  done. The admin dashboard shows a top-banner first-time-setup checklist.

---

