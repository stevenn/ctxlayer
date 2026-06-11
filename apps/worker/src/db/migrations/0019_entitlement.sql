-- 0019 — Tenant entitlement & admission (plan L).
--
-- Adds a lifecycle `status` to users (active/pending/suspended) plus two
-- admission mechanisms: pre-authorised `invites` and shared `join_codes`
-- (stored hashed). See docs/plan/L-entitlement.md.
--
-- D1/SQLite rules (G-conventions §G1): `users` is a referenced parent
-- (team_members, user_credentials, user_roles, … FK it) so we ALTER ADD
-- COLUMN rather than rebuild. Every enum column carries a CHECK. The new
-- child user references are ON DELETE SET NULL so an admin hard-delete of a
-- user doesn't trip them (and an invite/code keeps its row for the audit).

-- 1. Membership status on the existing users table.
--    DEFAULT 'active' backfills every existing row -> zero behaviour change.
ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'pending', 'suspended'));

-- Cheap pending-approval queue + status filters on the admin Users page.
CREATE INDEX idx_users_status ON users(status);

-- 2. Pre-authorised emails (the "invite" mechanism). A matching sign-in is
--    admitted directly as 'active' and the row is marked redeemed.
CREATE TABLE invites (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL,            -- normalised lowercase
  invited_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL,
  redeemed_at   INTEGER,                  -- set on first matching sign-in
  redeemed_user TEXT REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX idx_invites_email ON invites(LOWER(email));

-- 3. Shared join codes. Store a HASH, never the plaintext. The plaintext is
--    shown to the admin exactly once on creation.
CREATE TABLE join_codes (
  id              TEXT PRIMARY KEY,
  code_hash       TEXT NOT NULL,          -- SHA-256(code), lowercase hex
  label           TEXT NOT NULL DEFAULT '',
  domain_restrict TEXT,                   -- optional: only @<this> may redeem
  on_redeem       TEXT NOT NULL DEFAULT 'active'
                  CHECK (on_redeem IN ('active', 'pending')),
  max_uses        INTEGER,                -- NULL = unlimited
  uses            INTEGER NOT NULL DEFAULT 0,
  expires_at      INTEGER,                -- NULL = no expiry
  created_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at      INTEGER NOT NULL,
  revoked_at      INTEGER
);
CREATE UNIQUE INDEX idx_join_codes_hash ON join_codes(code_hash);
