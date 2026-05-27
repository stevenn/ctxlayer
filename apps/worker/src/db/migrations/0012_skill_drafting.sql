-- M8: catalogue diff tracking + drafter provenance.
-- See docs/plan/H/M8-drafting.md for the design.
--
-- input_schema_hash: sha256 of the canonicalised inputSchema, computed
--   on every refresh. Lets the refresh path detect actual schema
--   changes (vs. plain cache bumps) without re-parsing on each read.
-- last_schema_change_at: bumped only when input_schema_hash differs
--   from the previous value. NULL = never changed.
-- last_diff_summary: short human-readable diff string for the most
--   recent change ("added required: parent_id; removed: priority").
--   Overwritten on each change.
-- skills.drafter_meta: opaque JSON blob with provenance for AI-drafted
--   skills (model, version, context inputs, draft timestamp). NULL
--   for manually-authored skills.

ALTER TABLE upstream_tools ADD COLUMN input_schema_hash TEXT;
ALTER TABLE upstream_tools ADD COLUMN last_schema_change_at INTEGER;
ALTER TABLE upstream_tools ADD COLUMN last_diff_summary TEXT;

ALTER TABLE skills ADD COLUMN drafter_meta TEXT;
