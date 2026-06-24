-- Allow idp='access' for Cloudflare Access (Zero Trust) trust mode.
--
-- When the app is deployed behind Cloudflare Access, the auth middleware
-- (auth/cf-access.ts + auth/middleware.ts) upserts the edge-asserted user with
-- idp='access'. The original `users.idp` CHECK only permitted 'google'/'github',
-- so that insert failed. This widens the CHECK to include 'access'.
--
-- SQLite/D1 cannot ALTER a CHECK in place, so we use the standard table-rebuild
-- (same approach as 0013): create a new table with the corrected CHECK and the
-- CURRENT columns (note `status` + its index were added in 0019), copy rows,
-- drop, rename, and recreate the index. Child tables (team_members, user_roles,
-- user_credentials, doc/skill authorship, etc.) reference users(id) by name;
-- rebuilding under foreign_keys=OFF preserves the same ids so those FKs stay valid.

PRAGMA foreign_keys=OFF;

CREATE TABLE users_new (
  id           TEXT PRIMARY KEY,
  email        TEXT NOT NULL UNIQUE,
  name         TEXT,
  avatar_url   TEXT,
  idp          TEXT NOT NULL CHECK (idp IN ('google', 'github', 'access')),
  idp_sub      TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending', 'suspended')),
  UNIQUE(idp, idp_sub)
);

INSERT INTO users_new
  (id, email, name, avatar_url, idp, idp_sub, role, created_at, last_seen_at, status)
SELECT
  id, email, name, avatar_url, idp, idp_sub, role, created_at, last_seen_at, status
FROM users;

DROP TABLE users;

ALTER TABLE users_new RENAME TO users;

CREATE INDEX idx_users_status ON users(status);

PRAGMA foreign_keys=ON;
