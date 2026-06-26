-- Migration 0029: per-error detail on raw usage_events.
--
-- The usage dashboards only ever stored error COUNTS (rollups). To
-- surface the actual root cause in the UI without standing up a log
-- aggregator, we persist a classified code + a credential-scrubbed
-- message on the raw event row, populated for failures (status <> 'ok')
-- only. `usage_events` is already the 30-day self-pruning ring, so this
-- adds bounded forensic detail, not an unbounded log. Aggregated rollups
-- are untouched (messages have no place in a per-day aggregate).
--
-- ADD COLUMN + CREATE INDEX only — no table rebuild, so the 0013
-- PRAGMA foreign_keys=OFF parent-cascade trap (G-conventions §G1) does
-- not apply.
--
-- No CHECK on error_code by design: the code set is server-controlled and
-- expected to grow as we classify more failure shapes, and the column is
-- nullable forensic detail. A frozen CHECK would force a column-migration
-- on every new code; the read path treats it as a free-form string and
-- the SPA maps known codes to labels, unknown ones verbatim.

ALTER TABLE usage_events ADD COLUMN error_code TEXT;
ALTER TABLE usage_events ADD COLUMN error_message TEXT;

-- The drill-down query is `WHERE status <> 'ok' ... ORDER BY ts DESC`.
-- A partial index over just the error rows keeps it off a full table
-- scan as the raw table grows within the retention window (SQLite scans
-- the ASC index in reverse to satisfy the DESC order).
CREATE INDEX idx_usage_events_errors ON usage_events(ts) WHERE status <> 'ok';
