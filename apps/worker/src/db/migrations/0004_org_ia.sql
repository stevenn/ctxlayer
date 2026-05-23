-- Org information architecture: teams, products, upstream visibility,
-- doc tags. See docs/PLAN.md Section F for the design rationale.

CREATE TABLE teams (
  id           TEXT PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  description  TEXT,
  -- Reserved for future IdP sync: 'google:<group-email>' | 'github:<org>/<team-slug>'.
  -- v1 ignores this field at sign-in; admin manages members manually.
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
  role       TEXT NOT NULL DEFAULT 'member',  -- 'member' | 'lead'
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
-- if ANY row matches. New upstreams have zero rows -> invisible until an
-- admin grants. scope_id is NULL when scope_kind='everyone'.
CREATE TABLE upstream_visibility (
  upstream_id TEXT NOT NULL REFERENCES upstream_servers(id) ON DELETE CASCADE,
  scope_kind  TEXT NOT NULL,                  -- 'everyone' | 'team' | 'product'
  scope_id    TEXT,
  PRIMARY KEY (upstream_id, scope_kind, COALESCE(scope_id, ''))
);

-- Tags on documents. Used for filtering / shaping default agent context.
-- Does NOT gate read access -- every signed-in user can read every
-- non-deleted document.
CREATE TABLE doc_tags (
  doc_id    TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  tag_kind  TEXT NOT NULL,                    -- 'team' | 'product' | 'topic'
  tag_value TEXT NOT NULL,                    -- team_id | product_id | free-form topic slug
  PRIMARY KEY (doc_id, tag_kind, tag_value)
);
CREATE INDEX idx_doc_tags_lookup ON doc_tags(tag_kind, tag_value);
