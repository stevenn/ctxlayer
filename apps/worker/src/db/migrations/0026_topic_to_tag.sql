-- Migration 0026: rename the free-form tag_kind 'topic' → 'tag'.
--
-- Vocabulary standardisation: the free-form, non-gating tags (as opposed to
-- the structural team/product references) are now called "tags" everywhere —
-- UI, API (DocTags.tags / SkillTags.tags), and storage. This drops the old
-- "Topics" name and the redundant umbrella, leaving the model as
-- Teams · Products · Tags. (OKF frontmatter `tags` map to these.)
--
-- SQLite can't ALTER a CHECK constraint in place, so both tables are rebuilt.
-- doc_tags and skill_tags are LEAF tables (nothing REFERENCES them), so the
-- 0013 parent-cascade trap (G-conventions §G1) does not apply — we rebuild
-- the child directly, remapping existing 'topic' rows to 'tag'. The PK
-- (… , tag_kind, tag_value) keeps the value across the change.

-- ── doc_tags ──────────────────────────────────────────────────────────────
ALTER TABLE doc_tags RENAME TO doc_tags_old;

CREATE TABLE doc_tags (
  doc_id    TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  tag_kind  TEXT NOT NULL CHECK (tag_kind IN ('team', 'product', 'tag')),
  tag_value TEXT NOT NULL,
  PRIMARY KEY (doc_id, tag_kind, tag_value)
);

INSERT INTO doc_tags (doc_id, tag_kind, tag_value)
  SELECT doc_id,
         CASE tag_kind WHEN 'topic' THEN 'tag' ELSE tag_kind END,
         tag_value
  FROM doc_tags_old;

DROP TABLE doc_tags_old;
CREATE INDEX idx_doc_tags_lookup ON doc_tags(tag_kind, tag_value);

-- ── skill_tags (mirrors doc_tags) ─────────────────────────────────────────
ALTER TABLE skill_tags RENAME TO skill_tags_old;

CREATE TABLE skill_tags (
  skill_id  TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  tag_kind  TEXT NOT NULL CHECK (tag_kind IN ('team', 'product', 'tag')),
  tag_value TEXT NOT NULL,
  PRIMARY KEY (skill_id, tag_kind, tag_value)
);

INSERT INTO skill_tags (skill_id, tag_kind, tag_value)
  SELECT skill_id,
         CASE tag_kind WHEN 'topic' THEN 'tag' ELSE tag_kind END,
         tag_value
  FROM skill_tags_old;

DROP TABLE skill_tags_old;
CREATE INDEX idx_skill_tags_lookup ON skill_tags(tag_kind, tag_value);
