-- Doc lock: admin or doc creator can freeze edits to title / tags /
-- content. Sharing + ACL endpoints stay editable so admins can still
-- curate access. Per the design choice (M5 phase 3 side feature):
-- no bypass — even admins and the creator must explicitly unlock
-- before editing.
--
-- `locked_at` and `locked_by` move together. NULL locked_at = not
-- locked; NULL locked_by would be an integrity violation we never
-- write (lock endpoint always sets both). The pair gives the SPA
-- "Locked by <X> at <Y>" copy and the audit log a clean target.
--
-- ON DELETE SET NULL on the user FK so removing a user doesn't
-- unlock their previously-locked docs by side effect.
ALTER TABLE documents ADD COLUMN locked_at INTEGER;
ALTER TABLE documents ADD COLUMN locked_by TEXT REFERENCES users(id) ON DELETE SET NULL;
