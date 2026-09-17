-- When the CURRENT upstream grant was issued — i.e. the last interactive
-- authorization (OAuth code exchange), not the last token refresh.
--
-- Several upstream MCP servers give a grant a fixed ABSOLUTE lifetime from
-- the moment of authorization that no amount of refreshing extends (field
-- finding 2026-09-17: Datadog 14d, Linear ~25d, Sentry 30d). With this
-- stamp plus the admin-configured `authConfig.grantLifetimeDays`, ctxlayer
-- can warn BEFORE the cliff instead of discovering the death at the next
-- refresh. `created_at` can't carry this: the upsert keeps it across a
-- re-authorization that reuses the row, and `updated_at` moves on every
-- refresh.
--
-- Backfill from `created_at`: until now every interactive re-auth went
-- through a DELETE + INSERT of the row (Disconnect, or the wipe-and-retry
-- in api/upstream-oauth.ts), so for existing rows the two coincide.
-- Additive nullable column on a child table — no rebuild (G1 not in play).
ALTER TABLE user_credentials ADD COLUMN granted_at INTEGER;
UPDATE user_credentials SET granted_at = created_at WHERE granted_at IS NULL;
