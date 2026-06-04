-- Per-tool access control + a new cross-cutting "role" principal
-- (e.g. engineering, qa, product). Roles cut ACROSS teams: a user has a
-- team AND one-or-more roles. Design: docs/plan/J-tool-acl.md.
--
-- Three new tables (roles, user_roles, tool_access) plus a widened
-- upstream_visibility CHECK so roles can gate whole upstreams too.

-- Cross-cutting org roles. Admin-managed; mirrors `teams` (incl. the
-- reserved idp_group sync hook). Slugs carry the `role-` prefix.
CREATE TABLE roles (
  id             TEXT PRIMARY KEY,
  slug           TEXT NOT NULL UNIQUE,
  display_name   TEXT NOT NULL,
  description    TEXT,
  -- Reserved for future IdP sync, exactly like teams.idp_group. v1
  -- ignores this at sign-in; admin manages membership manually.
  idp_group      TEXT,
  managed_by_idp INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE user_roles (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id    TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, role_id)
);
CREATE INDEX idx_user_roles_user ON user_roles(user_id);

-- Per-tool ACL. Presence of ANY row for (upstream_id, tool_name) flips
-- that tool to allow-list mode: only the listed principals may call it.
-- Zero rows = inherit the upstream's visibility (open to anyone who can
-- see the upstream). Additive within the locked set: any matching row
-- grants. principal_id is '' when principal_kind='everyone' (same
-- empty-string sentinel upstream_visibility uses; SQLite forbids
-- COALESCE in a PK). No 'user' principal — ACLs target groups only.
--
-- Deliberately NOT a foreign key to upstream_tools(upstream_id,
-- tool_name): the catalogue cache is rebuilt via DELETE+INSERT on every
-- refresh (replaceCachedTools), so an FK would cascade-wipe these ACL
-- rows every 24h. We reference the tool by name and FK only the upstream
-- for cleanup. An upstream renaming a tool therefore strands its rule as
-- "orphaned" (flagged in the admin UI) rather than silently re-opening.
CREATE TABLE tool_access (
  upstream_id    TEXT NOT NULL REFERENCES upstream_servers(id) ON DELETE CASCADE,
  tool_name      TEXT NOT NULL,
  principal_kind TEXT NOT NULL CHECK (principal_kind IN ('everyone', 'role', 'team', 'product')),
  principal_id   TEXT NOT NULL DEFAULT '',
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (upstream_id, tool_name, principal_kind, principal_id)
);
CREATE INDEX idx_tool_access_upstream ON tool_access(upstream_id);

-- Widen upstream_visibility.scope_kind to admit 'role'. SQLite can't
-- ALTER a CHECK, so rebuild the table. upstream_visibility is a LEAF
-- (nothing references it), so its DROP cascades nowhere — the §G1
-- "never rebuild a referenced parent under FK=OFF" hazard does not
-- apply here. We still snapshot -> swap to preserve existing grants,
-- the partial unique index, and the upstream_servers FK.
CREATE TABLE upstream_visibility_new (
  upstream_id TEXT NOT NULL REFERENCES upstream_servers(id) ON DELETE CASCADE,
  scope_kind  TEXT NOT NULL CHECK (scope_kind IN ('everyone', 'team', 'product', 'role')),
  scope_id    TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (upstream_id, scope_kind, scope_id)
);
INSERT INTO upstream_visibility_new (upstream_id, scope_kind, scope_id)
  SELECT upstream_id, scope_kind, scope_id FROM upstream_visibility;
DROP TABLE upstream_visibility;
ALTER TABLE upstream_visibility_new RENAME TO upstream_visibility;
CREATE UNIQUE INDEX idx_uvis_everyone
  ON upstream_visibility(upstream_id)
  WHERE scope_kind = 'everyone';
