-- Autosave coalescing. Distinguish background autosaves (3s-debounce
-- crash-insurance) from explicit user saves so the revision history
-- reflects intentional checkpoints, not every keystroke burst.
--
-- Policy (enforced in db/revision-policy.ts + the PUT /content handlers):
--   * an autosave folds into the open rolling autosave revision when it's
--     the current head, by the same author, and inside the coalesce window;
--   * an explicit save / author change / window expiry cuts a fresh row;
--   * content identical to the head is a no-op (dedup).
--
-- Existing rows are grandfathered as 'explicit': they pre-date the policy
-- and must never be retroactively amended/coalesced into.
ALTER TABLE doc_revisions ADD COLUMN kind TEXT NOT NULL DEFAULT 'explicit'
  CHECK (kind IN ('autosave', 'explicit'));

ALTER TABLE skill_revisions ADD COLUMN kind TEXT NOT NULL DEFAULT 'explicit'
  CHECK (kind IN ('autosave', 'explicit'));
