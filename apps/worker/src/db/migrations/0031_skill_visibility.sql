-- Skill visibility: owner-scoped private drafting + explicit org sharing.
--
-- Additive column only. Safe on D1 (same shape as 0012 `drafter_meta` and
-- 0017 `kind`): ADD COLUMN with NOT NULL DEFAULT + CHECK does not rebuild the
-- table, so it dodges the parent-rebuild landmine that bit 0013/0028 (skills
-- is a referenced parent of skill_revisions / skill_tags / skill_attachments).
--
-- DEFAULT 'org' grandfathers every existing skill as org-visible, so the
-- read gate is unchanged for today's admin-authored skills. The gate combines
-- this column with `status` and ownership (apps/worker/src/skills/skill-access.ts):
--   readable = admin
--           OR created_by = caller           -- owner sees own (draft-and-test privately)
--           OR (visibility = 'org' AND status = 'published').
-- New user-authored skills are created private+draft; "Share" flips them to
-- org+published.
ALTER TABLE skills ADD COLUMN visibility TEXT NOT NULL DEFAULT 'org'
  CHECK (visibility IN ('private', 'org'));
