-- Migration 0014: per-tool resilience analytics (WI-5).
--
-- Durable (beyond the 30d raw-event window) counters so the admin usage
-- dashboard can show timeout rate + oversize-truncation counts per
-- tool/upstream without grepping logs. See docs/plan/I-upstream-resilience.md
-- §WI-5.
--
-- ADD COLUMN only — no parent-table rebuild, so the 0013
-- `PRAGMA foreign_keys=OFF` cascade trap (G-conventions §G1) does not
-- apply. NOT NULL DEFAULT 0 backfills existing rows.

ALTER TABLE usage_events ADD COLUMN truncated INTEGER NOT NULL DEFAULT 0;

ALTER TABLE usage_rollups_daily ADD COLUMN timeouts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_rollups_daily ADD COLUMN truncations INTEGER NOT NULL DEFAULT 0;
