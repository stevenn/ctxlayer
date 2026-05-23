-- Per-document ACL. Read access is open to every signed-in user; this
-- table only governs write access. A user may edit a doc when ANY of:
--   * users.role = 'admin'                          (global admin)
--   * documents.created_by = user.id                (author)
--   * doc_editors row (doc_id, 'user', user.id)     (explicitly granted)
--   * doc_editors row (doc_id, 'everyone', '')      (org-wide grant)
--
-- 'team' scope is intentionally not modelled yet. When it lands we add
-- 'team' to the CHECK constraint and reuse scope_id as team_id; the
-- access predicate gains one OR-branch.
--
-- scope_id uses the '' sentinel for scope_kind='everyone' so the
-- composite PRIMARY KEY (NOT NULL columns only) holds without resorting
-- to expressions (G1: SQLite forbids COALESCE in PRIMARY KEY).
CREATE TABLE doc_editors (
  doc_id     TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('user', 'everyone')),
  scope_id   TEXT NOT NULL DEFAULT '',
  granted_by TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (doc_id, scope_kind, scope_id),
  CHECK (
    (scope_kind = 'everyone' AND scope_id = '')
    OR (scope_kind = 'user' AND scope_id <> '')
  )
);

-- Lookup path: "what docs can this user edit by explicit grant?" and
-- "is there an 'everyone' grant on this doc?" Both go through the same
-- index because (scope_kind, scope_id) is the access selector.
CREATE INDEX idx_doc_editors_scope ON doc_editors(scope_kind, scope_id);
