-- Allow idp='access' for Cloudflare Access (Zero Trust) trust mode.
--
-- When the app is deployed behind Cloudflare Access, the auth middleware
-- (auth/cf-access.ts + auth/middleware.ts) upserts the edge-asserted user with
-- idp='access'. The original `users.idp` CHECK only permitted 'google'/'github',
-- so that insert failed. This widens the CHECK to include 'access'.
--
-- WHY THIS MIGRATION IS LONG (do not "simplify" it back to a plain rebuild):
-- `users` is a referenced PARENT and the only way to change a CHECK in SQLite is
-- to rebuild the table. On D1 that is a minefield (verified on a throwaway D1,
-- see docs/plan/G-conventions.md §G1):
--   * `PRAGMA foreign_keys=OFF` no-ops inside D1's migration transaction, so the
--     rebuild's `DROP TABLE users` runs an implicit DELETE that fires every
--     `ON DELETE` action — this is the 0013 data-loss trap.
--   * `defer_foreign_keys` does NOT suppress the CASCADE/SET NULL *actions*, and
--     worse, D1 records a NO-ACTION FK violation the instant a referenced user
--     row is deleted and never clears it — even re-inserting the SAME id (which a
--     rebuild does via DROP+RENAME) still fails the commit-time check. So a
--     snapshot/restore that only covers CASCADE children is not enough: the
--     NOT-NULL NO-ACTION child `skills.created_by` makes the DROP fail outright.
--   * D1 blocks `PRAGMA writable_schema` (SQLITE_AUTH) and ignores
--     `legacy_alter_table`, so the in-place-edit and rename-swap shortcuts are out.
--
-- The only safe path is to DETACH every user reference before the rebuild and
-- REATTACH after. Children enumerated by grepping `REFERENCES users(` against the
-- LIVE schema (not a comment), classified by ON DELETE:
--   CASCADE  (rows auto-deleted): user_credentials, team_members, user_roles,
--            git_user_credentials  -> snapshot whole rows, re-insert after.
--   SET NULL (fk auto-nulled)   : documents.locked_by, git_pull_requests.opened_by,
--            git_shared_credentials.created_by, git_sources.created_by,
--            invites.{invited_by,redeemed_user}, join_codes.created_by,
--            upstream_shared_credentials.created_by  -> snapshot (pk,fk), restore.
--   NO ACTION nullable          : documents.created_by, doc_revisions.author_id,
--            doc_editors.granted_by, doc_attachments.created_by  -> snapshot,
--            manually NULL before the rebuild, restore after.
--   NO ACTION not-null          : skills.created_by  -> snapshot the skills subtree
--            (skill_revisions + skill_attachments cascade off skills), DELETE
--            skills, restore all three after.

PRAGMA defer_foreign_keys = TRUE;

-- 1. Snapshot CASCADE children (SELECT * keeps BLOB ciphertext byte-exact).
CREATE TABLE _u28_user_credentials     AS SELECT * FROM user_credentials;
CREATE TABLE _u28_team_members         AS SELECT * FROM team_members;
CREATE TABLE _u28_user_roles           AS SELECT * FROM user_roles;
CREATE TABLE _u28_git_user_credentials AS SELECT * FROM git_user_credentials;

-- 2. Snapshot the skills subtree (skills.created_by is NOT NULL NO ACTION).
CREATE TABLE _u28_skills            AS SELECT * FROM skills;
CREATE TABLE _u28_skill_revisions   AS SELECT * FROM skill_revisions;
CREATE TABLE _u28_skill_attachments AS SELECT * FROM skill_attachments;

-- 3. Snapshot every nullable user-ref column, keyed by the child PK.
CREATE TABLE _u28_documents       AS SELECT id, created_by, locked_by FROM documents      WHERE created_by IS NOT NULL OR locked_by IS NOT NULL;
CREATE TABLE _u28_doc_revisions   AS SELECT id, author_id            FROM doc_revisions   WHERE author_id IS NOT NULL;
CREATE TABLE _u28_doc_editors     AS SELECT doc_id, scope_kind, scope_id, granted_by FROM doc_editors WHERE granted_by IS NOT NULL;
CREATE TABLE _u28_doc_attachments AS SELECT doc_id, upstream_id, tool_name, created_by   FROM doc_attachments WHERE created_by IS NOT NULL;
CREATE TABLE _u28_git_prs         AS SELECT id, opened_by            FROM git_pull_requests WHERE opened_by IS NOT NULL;
CREATE TABLE _u28_git_shared      AS SELECT git_source_id, created_by FROM git_shared_credentials WHERE created_by IS NOT NULL;
CREATE TABLE _u28_git_sources     AS SELECT id, created_by           FROM git_sources     WHERE created_by IS NOT NULL;
CREATE TABLE _u28_invites         AS SELECT id, invited_by, redeemed_user FROM invites    WHERE invited_by IS NOT NULL OR redeemed_user IS NOT NULL;
CREATE TABLE _u28_join_codes      AS SELECT id, created_by           FROM join_codes      WHERE created_by IS NOT NULL;
CREATE TABLE _u28_up_shared       AS SELECT upstream_id, created_by   FROM upstream_shared_credentials WHERE created_by IS NOT NULL;

-- 4. Detach: blank/clear every user reference so the rebuild's DROP has nothing
--    referencing a user row.
UPDATE documents                   SET created_by = NULL, locked_by = NULL;
UPDATE doc_revisions               SET author_id = NULL;
UPDATE doc_editors                 SET granted_by = NULL;
UPDATE doc_attachments             SET created_by = NULL;
UPDATE git_pull_requests           SET opened_by = NULL;
UPDATE git_shared_credentials      SET created_by = NULL;
UPDATE git_sources                 SET created_by = NULL;
UPDATE invites                     SET invited_by = NULL, redeemed_user = NULL;
UPDATE join_codes                  SET created_by = NULL;
UPDATE upstream_shared_credentials SET created_by = NULL;
-- Clear the CASCADE children + skills subtree explicitly (child-first), rather
-- than relying on the DROP's cascade. This makes the migration independent of
-- whether foreign-key enforcement is on (D1 prod) or off (some local runners):
-- the restore in steps 6-7 then always inserts into empty tables, never colliding
-- on a primary key with rows a cascade failed to remove.
DELETE FROM skill_revisions;
DELETE FROM skill_attachments;
DELETE FROM skills;
DELETE FROM user_credentials;
DELETE FROM team_members;
DELETE FROM user_roles;
DELETE FROM git_user_credentials;

-- 5. Rebuild users with the widened CHECK. Nothing references a user row now.
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

-- 6. Reattach CASCADE children (ids preserved -> FKs resolve).
INSERT INTO user_credentials     SELECT * FROM _u28_user_credentials;
INSERT INTO team_members         SELECT * FROM _u28_team_members;
INSERT INTO user_roles           SELECT * FROM _u28_user_roles;
INSERT INTO git_user_credentials SELECT * FROM _u28_git_user_credentials;

-- 7. Reattach the skills subtree (FK order: skills -> revisions/attachments).
INSERT INTO skills            SELECT * FROM _u28_skills;
INSERT INTO skill_revisions   SELECT * FROM _u28_skill_revisions;
INSERT INTO skill_attachments SELECT * FROM _u28_skill_attachments;

-- 8. Reattach nullable refs from their snapshots.
UPDATE documents SET created_by = (SELECT created_by FROM _u28_documents s WHERE s.id = documents.id),
                     locked_by  = (SELECT locked_by  FROM _u28_documents s WHERE s.id = documents.id)
  WHERE id IN (SELECT id FROM _u28_documents);
UPDATE doc_revisions SET author_id = (SELECT author_id FROM _u28_doc_revisions s WHERE s.id = doc_revisions.id)
  WHERE id IN (SELECT id FROM _u28_doc_revisions);
UPDATE doc_editors SET granted_by = (SELECT granted_by FROM _u28_doc_editors s WHERE s.doc_id = doc_editors.doc_id AND s.scope_kind = doc_editors.scope_kind AND s.scope_id = doc_editors.scope_id)
  WHERE (doc_id, scope_kind, scope_id) IN (SELECT doc_id, scope_kind, scope_id FROM _u28_doc_editors);
UPDATE doc_attachments SET created_by = (SELECT created_by FROM _u28_doc_attachments s WHERE s.doc_id = doc_attachments.doc_id AND s.upstream_id = doc_attachments.upstream_id AND s.tool_name = doc_attachments.tool_name)
  WHERE (doc_id, upstream_id, tool_name) IN (SELECT doc_id, upstream_id, tool_name FROM _u28_doc_attachments);
UPDATE git_pull_requests SET opened_by = (SELECT opened_by FROM _u28_git_prs s WHERE s.id = git_pull_requests.id)
  WHERE id IN (SELECT id FROM _u28_git_prs);
UPDATE git_shared_credentials SET created_by = (SELECT created_by FROM _u28_git_shared s WHERE s.git_source_id = git_shared_credentials.git_source_id)
  WHERE git_source_id IN (SELECT git_source_id FROM _u28_git_shared);
UPDATE git_sources SET created_by = (SELECT created_by FROM _u28_git_sources s WHERE s.id = git_sources.id)
  WHERE id IN (SELECT id FROM _u28_git_sources);
UPDATE invites SET invited_by    = (SELECT invited_by    FROM _u28_invites s WHERE s.id = invites.id),
                   redeemed_user = (SELECT redeemed_user FROM _u28_invites s WHERE s.id = invites.id)
  WHERE id IN (SELECT id FROM _u28_invites);
UPDATE join_codes SET created_by = (SELECT created_by FROM _u28_join_codes s WHERE s.id = join_codes.id)
  WHERE id IN (SELECT id FROM _u28_join_codes);
UPDATE upstream_shared_credentials SET created_by = (SELECT created_by FROM _u28_up_shared s WHERE s.upstream_id = upstream_shared_credentials.upstream_id)
  WHERE upstream_id IN (SELECT upstream_id FROM _u28_up_shared);

-- 9. Drop holding tables. The deferred FK check runs at COMMIT and passes:
--    every reattached child references a preserved id.
DROP TABLE _u28_user_credentials;
DROP TABLE _u28_team_members;
DROP TABLE _u28_user_roles;
DROP TABLE _u28_git_user_credentials;
DROP TABLE _u28_skills;
DROP TABLE _u28_skill_revisions;
DROP TABLE _u28_skill_attachments;
DROP TABLE _u28_documents;
DROP TABLE _u28_doc_revisions;
DROP TABLE _u28_doc_editors;
DROP TABLE _u28_doc_attachments;
DROP TABLE _u28_git_prs;
DROP TABLE _u28_git_shared;
DROP TABLE _u28_git_sources;
DROP TABLE _u28_invites;
DROP TABLE _u28_join_codes;
DROP TABLE _u28_up_shared;
