-- Per-call usage events plus daily rollups for fast admin dashboards.

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
  status        TEXT NOT NULL
);
CREATE INDEX idx_usage_user_ts     ON usage_events(user_id, ts DESC);
CREATE INDEX idx_usage_upstream_ts ON usage_events(upstream_id, ts DESC);

CREATE TABLE usage_rollups_daily (
  day           INTEGER NOT NULL,
  user_id       TEXT NOT NULL,
  upstream_id   TEXT,
  tool          TEXT NOT NULL,
  calls         INTEGER NOT NULL DEFAULT 0,
  req_bytes     INTEGER NOT NULL DEFAULT 0,
  resp_bytes    INTEGER NOT NULL DEFAULT 0,
  req_tokens    INTEGER NOT NULL DEFAULT 0,
  resp_tokens   INTEGER NOT NULL DEFAULT 0,
  errors        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, user_id, COALESCE(upstream_id, ''), tool)
);
