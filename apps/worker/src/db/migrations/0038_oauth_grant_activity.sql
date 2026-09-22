-- Idle-based expiry for MCP logins ("sliding session"), replacing the
-- library's absolute refresh-token lifetime.
--
-- `workers-oauth-provider` stamps `grant.expiresAt = authorized_at +
-- refreshTokenTTL` ONCE, at the authorization-code exchange, and never slides
-- it: the refresh path re-saves the same absolute `expiration`, and the
-- token-exchange callback is explicitly forbidden from changing
-- `refreshTokenTTL`. A client that refreshed perfectly every hour was still
-- logged out on a fixed date — the 30 d default, then our 90 d (migration-era
-- `MCP_LOGIN_TTL_SECONDS`). The DCR client record had the same shape
-- (`clientRegistrationTTL`, stamped at registration, never renewed on use),
-- so it capped the login independently.
--
-- Both TTLs are now passed as `undefined` — the KV records carry no
-- expiration at all — and the expiry policy lives here instead: a grant dies
-- when it has not been REFRESHED for `MCP_LOGIN_IDLE_DAYS`. Refreshing keeps
-- you signed in; going quiet logs you out.
--
-- One row per live grant. `last_refresh_at` is stamped by the provider's
-- `tokenExchangeCallback` on every exchange (code + refresh); the nightly
-- `grant-idle-prune` job reconciles this table against KV and revokes the
-- rows that went quiet (oauth/grant-sweep.ts).
--
-- No FK to `users`: KV is authoritative for grants and this table is a stamp
-- ledger the sweep reconciles against it (seeding missing rows, deleting
-- orphans), so a NOT NULL child of `users` would only add a parent-rebuild
-- landmine (conventions §G1) for integrity the sweep already provides.
CREATE TABLE oauth_grant_activity (
  grant_id        TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  client_id       TEXT NOT NULL DEFAULT '',
  created_at      INTEGER NOT NULL,
  last_refresh_at INTEGER NOT NULL
);

-- The sweep's read: oldest-quiet first.
CREATE INDEX idx_grant_activity_idle ON oauth_grant_activity(last_refresh_at);
-- Per-user cleanup (suspend/delete revokes every grant a user holds).
CREATE INDEX idx_grant_activity_user ON oauth_grant_activity(user_id);
