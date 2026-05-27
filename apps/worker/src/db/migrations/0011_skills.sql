-- M7a: skills primitive (separate from docs). See docs/plan/H/M7a-worker.md
-- for the design rationale. Skills are org-specific procedural playbooks
-- the agent loads on demand; surfaced over MCP as a `list_skills` tool +
-- `mcp://ctxlayer/skills/{slug}` resource template, and over the CLI as
-- SKILL.md files materialised under ~/.claude/skills/ctxlayer.
--
-- Open-read for any signed-in user (status='published'); admin-write.
-- Status gates visibility: drafts are admin-only; archived are hidden
-- from list_skills.

CREATE TABLE skills (
  id              TEXT PRIMARY KEY,
  slug            TEXT NOT NULL UNIQUE,
  title           TEXT NOT NULL,
  description     TEXT NOT NULL,
  trigger_text    TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'published', 'archived')),
  current_rev_id  TEXT,
  r2_snapshot     TEXT,
  created_by      TEXT NOT NULL REFERENCES users(id),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  deleted_at      INTEGER
);
CREATE INDEX idx_skills_status_updated
  ON skills(status, updated_at DESC)
  WHERE deleted_at IS NULL;

-- Mirrors doc_revisions: append-only history of body snapshots. R2 keys
-- live under skills/{id}/revisions/{rev}.json + skills/{id}/snapshot.json
-- (see storage/skills-r2.ts). Cascade on parent delete so revisions
-- can never orphan their owner.
CREATE TABLE skill_revisions (
  id           TEXT PRIMARY KEY,
  skill_id     TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  author_id    TEXT REFERENCES users(id),
  r2_key       TEXT NOT NULL,
  byte_size    INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_skill_revs_skill ON skill_revisions(skill_id, created_at DESC);

-- Mirrors doc_tags. tag_kind ∈ team | product | topic; tags do NOT
-- gate read (open-read by design); list_skills filters by tag scope
-- when the caller passes one, but doesn't restrict by default.
CREATE TABLE skill_tags (
  skill_id  TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  tag_kind  TEXT NOT NULL CHECK (tag_kind IN ('team', 'product', 'topic')),
  tag_value TEXT NOT NULL,
  PRIMARY KEY (skill_id, tag_kind, tag_value)
);
CREATE INDEX idx_skill_tags_lookup ON skill_tags(tag_kind, tag_value);

-- Skill ↔ upstream(.tool) attachments. tool_name='' = whole-upstream
-- attachment (skill surfaces on the upstream row); tool_name='foo' =
-- per-tool attachment (skill surfaces on the foo tool row in the
-- catalogue view). '' sentinel + PK includes tool_name to comply
-- with the D1 "no expressions in PK" rule.
CREATE TABLE skill_attachments (
  skill_id     TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  upstream_id  TEXT NOT NULL REFERENCES upstream_servers(id) ON DELETE CASCADE,
  tool_name    TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  created_by   TEXT REFERENCES users(id),
  PRIMARY KEY (skill_id, upstream_id, tool_name)
);
CREATE INDEX idx_skill_attach_upstream ON skill_attachments(upstream_id, tool_name);

-- Doc ↔ upstream(.tool) attachments. Mirrors skill_attachments. Lets
-- reference docs ("Datadog naming conventions") surface alongside
-- procedural skills on the upstream's MCP listing.
CREATE TABLE doc_attachments (
  doc_id       TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  upstream_id  TEXT NOT NULL REFERENCES upstream_servers(id) ON DELETE CASCADE,
  tool_name    TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  created_by   TEXT REFERENCES users(id),
  PRIMARY KEY (doc_id, upstream_id, tool_name)
);
CREATE INDEX idx_doc_attach_upstream ON doc_attachments(upstream_id, tool_name);
