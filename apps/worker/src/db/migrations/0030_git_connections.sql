-- 0030_git_connections.sql
--
-- Split a git "source" into a CONNECTION (auth/identity) + REPOS (what to
-- mirror), so an operator configures provider + OAuth/token + visibility ONCE
-- and hangs many repos off it (connect OAuth once → every repo writable).
--
--   git_connections  — provider, base_url, default strategies, OAuth client
--                      config; OWNS the shared token, the per-user tokens, and
--                      the visibility grants.
--   git_sources      — KEPT as the per-repo row (owner/project/repo/branch/
--                      folder/product/cadence/last_sync). Now carries
--                      connection_id. A `git_sources` row == a REPO; its auth
--                      lives on its git_connection. (Table name unchanged on
--                      purpose: renaming it would force rebuilding the central
--                      `documents` parent — the G1 NO-ACTION-child landmine —
--                      or a DROP of an FK column, which SQLite forbids. The
--                      vestigial-name tradeoff mirrors the `kind`-column
--                      precedent.)
--
-- Why this is G1-safe: we never rebuild a *referenced parent*. We only
--   (a) CREATE new tables, (b) rebuild LEAF tables (shared/user creds +
--   visibility — nothing references them) to re-key them onto connection_id,
--   and (c) ADD a nullable column. No DROP of a referenced table, no
--   DROP COLUMN, no `documents` rebuild. Credential BLOBs ride INSERT…SELECT
--   byte-exact.
--
-- Existing data maps 1:1: each git_sources row S gets a connection
-- `conn_<S.id>`; S.connection_id points at it; S's creds + visibility move to
-- that connection unchanged.

-- ── 1. Connection table ──────────────────────────────────────────────────
CREATE TABLE git_connections (
  id             TEXT PRIMARY KEY,
  slug           TEXT NOT NULL UNIQUE,
  display_name   TEXT NOT NULL,
  provider       TEXT NOT NULL CHECK (provider IN ('github','gitlab','azure')),
  base_url       TEXT,
  read_strategy  TEXT NOT NULL DEFAULT 'shared_bearer'
                 CHECK (read_strategy IN ('shared_bearer','user_bearer','user_oauth')),
  write_strategy TEXT NOT NULL DEFAULT 'user_bearer'
                 CHECK (write_strategy IN ('shared_bearer','user_bearer','user_oauth')),
  -- Static (pre-registered) OAuth client config JSON (sealed secret), or NULL.
  auth_config    TEXT,
  created_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

-- One connection per existing source (deterministic id/slug — no UUIDs in SQL).
INSERT INTO git_connections
  (id, slug, display_name, provider, base_url, read_strategy, write_strategy,
   auth_config, created_by, created_at, updated_at)
SELECT
  'conn_' || id,
  CASE WHEN slug LIKE 'repo-%' THEN 'conn-' || substr(slug, 6) ELSE 'conn-' || slug END,
  display_name,
  provider, base_url, read_strategy, write_strategy, auth_config,
  created_by, created_at, updated_at
FROM git_sources;

-- ── 2. Repo → connection link ────────────────────────────────────────────
-- Nullable + REFERENCES (SQLite ADD COLUMN can't be NOT NULL w/o default);
-- backfilled for every row, always set on new inserts.
ALTER TABLE git_sources ADD COLUMN connection_id TEXT REFERENCES git_connections(id) ON DELETE CASCADE;
UPDATE git_sources SET connection_id = 'conn_' || id;
CREATE INDEX idx_git_sources_connection ON git_sources(connection_id);

-- ── 3. Re-key shared credentials onto the connection (leaf rebuild) ───────
CREATE TABLE git_shared_credentials_new (
  connection_id TEXT PRIMARY KEY REFERENCES git_connections(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('bearer')),
  ciphertext    BLOB NOT NULL,
  iv            BLOB NOT NULL,
  key_version   INTEGER NOT NULL DEFAULT 1,
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
INSERT INTO git_shared_credentials_new
  (connection_id, kind, ciphertext, iv, key_version, created_by, created_at, updated_at)
SELECT 'conn_' || git_source_id, kind, ciphertext, iv, key_version, created_by, created_at, updated_at
FROM git_shared_credentials;
DROP TABLE git_shared_credentials;
ALTER TABLE git_shared_credentials_new RENAME TO git_shared_credentials;

-- ── 4. Re-key per-user credentials onto the connection (leaf rebuild) ─────
CREATE TABLE git_user_credentials_new (
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES git_connections(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('bearer','oauth')),
  ciphertext    BLOB NOT NULL,
  iv            BLOB NOT NULL,
  key_version   INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (user_id, connection_id)
);
INSERT INTO git_user_credentials_new
  (user_id, connection_id, kind, ciphertext, iv, key_version, created_at, updated_at)
SELECT user_id, 'conn_' || git_source_id, kind, ciphertext, iv, key_version, created_at, updated_at
FROM git_user_credentials;
DROP TABLE git_user_credentials;
ALTER TABLE git_user_credentials_new RENAME TO git_user_credentials;

-- ── 5. Re-key visibility onto the connection (leaf rebuild + rename) ──────
CREATE TABLE git_connection_visibility (
  connection_id TEXT NOT NULL REFERENCES git_connections(id) ON DELETE CASCADE,
  scope_kind    TEXT NOT NULL CHECK (scope_kind IN ('everyone','team','product')),
  scope_id      TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (connection_id, scope_kind, scope_id)
);
INSERT INTO git_connection_visibility (connection_id, scope_kind, scope_id)
SELECT 'conn_' || git_source_id, scope_kind, scope_id FROM git_source_visibility;
DROP TABLE git_source_visibility;
