-- Migration 0023: bare-ts index for the nightly usage-events prune.
--
-- `pruneUsageEvents` runs `DELETE FROM usage_events WHERE ts < ?` on the
-- nightly cron. The existing composite indexes lead with user_id /
-- upstream_id, so the bare-ts range predicate was a full table scan that
-- grew with retention volume. CREATE INDEX only — no table rebuild, so
-- the 0013 `PRAGMA foreign_keys=OFF` cascade trap (G-conventions §G1)
-- does not apply.

CREATE INDEX idx_usage_events_ts ON usage_events(ts);
