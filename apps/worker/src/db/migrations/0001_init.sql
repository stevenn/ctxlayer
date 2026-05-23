-- Users, upstreams, per-user credentials, cached upstream tool catalogue.

CREATE TABLE users (
  id           TEXT PRIMARY KEY,
  email        TEXT NOT NULL UNIQUE,
  name         TEXT,
  avatar_url   TEXT,
  idp          TEXT NOT NULL,
  idp_sub      TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'user',
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER,
  UNIQUE(idp, idp_sub)
);

CREATE TABLE upstream_servers (
  id            TEXT PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  transport     TEXT NOT NULL,
  url           TEXT,
  auth_strategy TEXT NOT NULL,
  auth_config   TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE upstream_tools (
  upstream_id   TEXT NOT NULL REFERENCES upstream_servers(id) ON DELETE CASCADE,
  tool_name     TEXT NOT NULL,
  description   TEXT,
  input_schema  TEXT NOT NULL,
  cached_at     INTEGER NOT NULL,
  PRIMARY KEY (upstream_id, tool_name)
);

CREATE TABLE user_credentials (
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  upstream_id  TEXT NOT NULL REFERENCES upstream_servers(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  ciphertext   BLOB NOT NULL,
  iv           BLOB NOT NULL,
  key_version  INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (user_id, upstream_id)
);

CREATE TABLE sandbox_sessions (
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  upstream_id    TEXT NOT NULL REFERENCES upstream_servers(id) ON DELETE CASCADE,
  sandbox_id     TEXT NOT NULL,
  state          TEXT NOT NULL,
  last_active_at INTEGER NOT NULL,
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (user_id, upstream_id)
);

CREATE TABLE audit_log (
  id        TEXT PRIMARY KEY,
  ts        INTEGER NOT NULL,
  actor_id  TEXT,
  action    TEXT NOT NULL,
  target    TEXT,
  meta      TEXT
);
CREATE INDEX idx_audit_ts ON audit_log(ts DESC);
