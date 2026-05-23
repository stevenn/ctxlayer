-- Curated documents and their revision history.

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
CREATE INDEX idx_documents_updated ON documents(updated_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE doc_revisions (
  id           TEXT PRIMARY KEY,
  doc_id       TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  author_id    TEXT REFERENCES users(id),
  r2_key       TEXT NOT NULL,
  byte_size    INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_doc_rev_doc ON doc_revisions(doc_id, created_at DESC);
