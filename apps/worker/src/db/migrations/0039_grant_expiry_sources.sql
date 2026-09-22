-- Where "when does this authorization die?" comes from — in the order the
-- answer is worth anything (see `resolveGrantExpiry` in shared).
--
-- Until now there was one source: an admin typing `grantLifetimeDays` into the
-- drawer, from numbers a human derived by hand off a spreadsheet of deaths.
-- Two better ones exist and neither was captured.
--
-- 1. `user_credentials.auth_expires_at` — what the PROVIDER said, absolute
--    unix seconds, from a `refresh_token_expires_in` on a token response.
--    Authoritative when present. It usually is not: OAuth has no standard
--    field for a refresh token's lifetime (RFC 6749 leaves it undefined), so
--    it is a de-facto extension only some providers send — and the MCP SDK's
--    token schema used to drop it before we ever saw it.
--
-- 2. `upstream_grant_observations` + `upstream_servers.observed_grant_days` —
--    what ctxlayer MEASURED. One row per authorization that actually died
--    here (`granted_at` → the moment the refresh was permanently rejected),
--    reduced to a median at each death. This is the same reasoning that
--    produced the hand-set 14/25/30, done continuously instead of once, so it
--    self-corrects when a provider changes policy.
--
-- Observations are kept per user because the same upstream can behave
-- differently per account (plan, SSO policy), and because a single outlier —
-- a user disconnecting by hand on day 2 — must be visible as one sample among
-- many rather than silently drag the estimate down.
ALTER TABLE user_credentials ADD COLUMN auth_expires_at INTEGER;

CREATE TABLE upstream_grant_observations (
  id            TEXT PRIMARY KEY,
  upstream_id   TEXT NOT NULL REFERENCES upstream_servers(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL,
  -- When that authorization was granted, and when its refresh was
  -- permanently rejected. The difference is the observation.
  granted_at    INTEGER NOT NULL,
  died_at       INTEGER NOT NULL,
  lifetime_days REAL NOT NULL
);

-- The estimator reads the most recent deaths per upstream.
CREATE INDEX idx_grant_obs_upstream ON upstream_grant_observations(upstream_id, died_at DESC);

-- Median of the recent observations, whole days; NULL until enough deaths
-- (MIN_GRANT_OBSERVATIONS) have been recorded to mean anything. Denormalised
-- onto the upstream so the hot read paths (`list_upstreams`, /api/upstreams)
-- cost no aggregate.
ALTER TABLE upstream_servers ADD COLUMN observed_grant_days INTEGER;
