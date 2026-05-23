-- Per-call usage events plus daily rollups for fast admin dashboards.
--
-- usage_events.upstream_id is nullable (NULL = built-in tool). The rollup
-- table uses the empty string as the sentinel for "self" so the composite
-- PRIMARY KEY column can be NOT NULL — SQLite forbids expressions like
-- COALESCE() in PRIMARY KEY clauses, and PK columns marked NOT NULL avoid
-- the NULL-≠-NULL uniqueness pitfall. The queue consumer normalises NULL
-- to '' when upserting.

CREATE TABLE usage_events (
  id            TEXT PRIMARY KEY,
  ts            INTEGER NOT NULL,
  user_id       TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  upstream_id   TEXT,
  tool          TEXT NOT NULL,
  req_bytes     INTEGER NOT NULL,
  resp_bytes    INTEGER NOT NULL,
  req_tokens    INTEGER NOT NULL,
  resp_tokens   INTEGER NOT NULL,
  latency_ms    INTEGER NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('ok', 'error', 'timeout'))
);
CREATE INDEX idx_usage_user_ts     ON usage_events(user_id, ts DESC);
CREATE INDEX idx_usage_upstream_ts ON usage_events(upstream_id, ts DESC);

CREATE TABLE usage_rollups_daily (
  day           INTEGER NOT NULL,
  user_id       TEXT NOT NULL,
  upstream_id   TEXT NOT NULL DEFAULT '',  -- '' = built-in / self
  tool          TEXT NOT NULL,
  calls         INTEGER NOT NULL DEFAULT 0,
  req_bytes     INTEGER NOT NULL DEFAULT 0,
  resp_bytes    INTEGER NOT NULL DEFAULT 0,
  req_tokens    INTEGER NOT NULL DEFAULT 0,
  resp_tokens   INTEGER NOT NULL DEFAULT 0,
  errors        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, user_id, upstream_id, tool)
);
