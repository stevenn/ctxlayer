-- Migration 0025: OKF (Open Knowledge Format) frontmatter fields on docs.
--
-- The doc editor's right rail becomes the canonical frontmatter editor for
-- docs that interoperate with OKF (Open Knowledge Format):
--   https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md
-- (reference: docs/plan/M-okf.md). Three recommended OKF fields get
-- first-class, queryable homes:
--
--   doc_type     -- OKF `type` (required on export): free string, e.g.
--                   'Playbook', 'API Endpoint'. Distinct from `kind`
--                   ('doc'|'prompt'), which drives ctxlayer behaviour.
--   description  -- OKF `description`: single-sentence summary.
--   resource     -- OKF `resource`: URI identifying the underlying asset.
--
-- `okf_frontmatter` preserves the raw YAML block (between the --- fences)
-- exactly as imported, so unknown/extra producer keys + `okf_version`
-- survive a round-trip on export / write-back (OKF requires consumers to
-- preserve unknown keys). NULL = the doc never carried frontmatter; the
-- export/write-back paths then synthesise (export) or skip (write-back)
-- frontmatter accordingly. Well-known fields above are re-derived from the
-- rail on export and overlay the preserved block.
--
-- OKF `tags` map to the existing free-form *tags* (doc_tags tag_kind='tag',
-- see migration 0026), never team/product (those gate visibility). OKF
-- `title` maps to documents.title,
-- `timestamp` to updated_at — both already columns.
--
-- ALTER TABLE ADD COLUMN only — no parent-table rebuild, so the 0013
-- `PRAGMA foreign_keys=OFF` cascade trap (G-conventions §G1) does not apply.

ALTER TABLE documents ADD COLUMN doc_type        TEXT;
ALTER TABLE documents ADD COLUMN description      TEXT;
ALTER TABLE documents ADD COLUMN resource         TEXT;
ALTER TABLE documents ADD COLUMN okf_frontmatter  TEXT;
