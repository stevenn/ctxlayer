-- M-post-M6: SSO/group-sync prep for teams.
--
-- `idp_group` already lives in `teams` (from migration 0004) — reserved
-- for values like `google:<group-email>` or `github:<org>/<team-slug>`.
-- This migration adds the companion flag `managed_by_idp` that signals
-- whether a team's membership is owned by the IdP sync job (when one
-- exists) or by manual admin curation.
--
-- v1 ships only the schema + admin UI surface; there is NO sync logic
-- yet. The column is honored only when an admin sets it — backend
-- behavior is unchanged until a real sync job lands. See
-- docs/plan/F-org-ia.md for the longer-term design.

ALTER TABLE teams
  ADD COLUMN managed_by_idp INTEGER NOT NULL DEFAULT 0
  CHECK (managed_by_idp IN (0, 1));
