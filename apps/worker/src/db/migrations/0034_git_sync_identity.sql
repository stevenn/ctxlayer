-- Designated sync identity for scheduled git sync on user_* read strategies.
-- The hourly cron has no acting user, so user_oauth/user_bearer sources never
-- synced unattended; this column names the user whose stored git credential
-- the schedule may act with. Set ONLY via self-designation (the credential
-- owner opts in on /api/admin/git-sources/:id/sync-identity) — never point it
-- at someone else's tokens. Un-FK'd TEXT on purpose (audit_log.actor_id
-- precedent): a users-table rebuild must not gain another NOT-NULL child, and
-- a missing/suspended designee is handled at enqueue time (skip + log).
ALTER TABLE git_sources ADD COLUMN sync_as_user_id TEXT;
