-- Drop the stdio-via-sandbox track entirely.
--
-- A stdio MCP upstream is now served by the bring-your-own-bridge model:
-- the operator runs a stdio<->HTTP bridge themselves and registers the
-- resulting HTTP endpoint as an ordinary `streamable_http` upstream. There
-- is therefore no dedicated stdio transport, and the inert `sandbox_sessions`
-- reservation from 0001 is removed.
--
-- This migration:
--   1. Drops the (always-empty) `sandbox_sessions` table.
--   2. Narrows the `upstream_servers.transport` CHECK from
--      ('streamable_http','sse','stdio_daytona') to ('streamable_http','sse').
--
-- SQLite/D1 cannot ALTER a CHECK constraint in place, so we use the standard
-- table-rebuild: create a new table with the corrected CHECK and otherwise
-- IDENTICAL columns/constraints to 0001, copy rows over, drop the old table,
-- and rename. `upstream_servers` carries no separate indexes or triggers
-- (only the inline UNIQUE on `slug`), and no later migration added columns to
-- it, so nothing else needs recreating. Child tables (upstream_tools,
-- user_credentials, upstream_visibility, upstream_shared_credentials,
-- skill_attachments, doc_attachments, usage_events) reference
-- `upstream_servers(id)` by name with ON DELETE CASCADE; rebuilding under
-- `foreign_keys=OFF` preserves the same id values so those FKs stay valid.

PRAGMA foreign_keys=OFF;

DROP TABLE IF EXISTS sandbox_sessions;

CREATE TABLE upstream_servers_new (
  id            TEXT PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  transport     TEXT NOT NULL CHECK (transport IN ('streamable_http', 'sse')),
  url           TEXT,
  auth_strategy TEXT NOT NULL CHECK (auth_strategy IN ('none', 'shared_bearer', 'user_bearer', 'user_oauth')),
  auth_config   TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

INSERT INTO upstream_servers_new
  (id, slug, display_name, transport, url, auth_strategy, auth_config,
   enabled, created_at, updated_at)
SELECT
  id, slug, display_name, transport, url, auth_strategy, auth_config,
  enabled, created_at, updated_at
FROM upstream_servers;

DROP TABLE upstream_servers;

ALTER TABLE upstream_servers_new RENAME TO upstream_servers;

PRAGMA foreign_keys=ON;
