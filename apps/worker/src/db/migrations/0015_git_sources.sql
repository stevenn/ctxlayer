-- Git repo mirroring (GitHub / GitLab / Azure DevOps).
--
-- A `git_source` mirrors *.md files out of a repo branch into the doc
-- store and opens PRs/MRs for edits made in our editor. It is NOT an MCP
-- upstream — it lives on its own tables but reuses the same three
-- credential strategies (shared_bearer / user_bearer / user_oauth) and
-- the AES-GCM seal/open helper, with the credential shape mirroring
-- upstream_shared_credentials / user_credentials 1:1.
--
-- Additive only: new tables + ALTER TABLE ADD COLUMN. We never rebuild a
-- referenced parent (documents/users) — the 0013 FK-cascade lesson.
-- Enum-shaped columns carry CHECK constraints; partial UNIQUE indexes
-- guard the nullable invariant.

CREATE TABLE git_sources (
  id               TEXT PRIMARY KEY,
  slug             TEXT NOT NULL UNIQUE,
  display_name     TEXT NOT NULL,
  provider         TEXT NOT NULL CHECK (provider IN ('github','gitlab','azure')),
  -- API base. NULL ⇒ the provider default (api.github.com / gitlab.com /
  -- dev.azure.com). Non-null for self-hosted (GH Enterprise, etc).
  base_url         TEXT,
  -- Repo identity within the provider. GitHub: owner + repo. GitLab:
  -- project path or numeric id in `repo`. Azure: org in `owner`,
  -- project, repo.
  owner            TEXT NOT NULL DEFAULT '',
  project          TEXT NOT NULL DEFAULT '',
  repo             TEXT NOT NULL DEFAULT '',
  -- Branch we mirror FROM and open PRs AGAINST (main / production).
  branch           TEXT NOT NULL,
  -- Optional path prefix restricting the mirror (e.g. 'docs/'). '' = whole repo.
  path_prefix      TEXT NOT NULL DEFAULT '',
  -- Credential strategy split: read/sync/index vs write-back authorship.
  -- Unattended (cron) sync has no user, so read should be shared_bearer
  -- in practice; user_* read only works during an interactive sync.
  read_strategy    TEXT NOT NULL DEFAULT 'shared_bearer'
                   CHECK (read_strategy IN ('shared_bearer','user_bearer','user_oauth')),
  write_strategy   TEXT NOT NULL DEFAULT 'user_bearer'
                   CHECK (write_strategy IN ('shared_bearer','user_bearer','user_oauth')),
  -- ctxlayer folder under which synced docs are filed (mirrors the repo
  -- tree below it). '' = root.
  folder_root      TEXT NOT NULL DEFAULT '',
  -- Cron-driven sync cadence; the scheduled handler checks this against
  -- last_synced_at to decide which sources are due.
  sync_interval    TEXT NOT NULL DEFAULT 'daily'
                   CHECK (sync_interval IN ('hourly','6x_daily','2x_daily','daily','weekly')),
  enabled          INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  last_synced_at   INTEGER,
  last_sync_status TEXT CHECK (last_sync_status IN ('ok','partial','error')),
  last_sync_error  TEXT,
  created_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX idx_git_sources_enabled ON git_sources(enabled, updated_at DESC);

-- Visibility, mirrors upstream_visibility exactly (additive grants).
CREATE TABLE git_source_visibility (
  git_source_id TEXT NOT NULL REFERENCES git_sources(id) ON DELETE CASCADE,
  scope_kind    TEXT NOT NULL CHECK (scope_kind IN ('everyone','team','product')),
  scope_id      TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (git_source_id, scope_kind, scope_id)
);

-- Org-level read/sync/index token (PAT). Mirrors upstream_shared_credentials.
CREATE TABLE git_shared_credentials (
  git_source_id TEXT PRIMARY KEY REFERENCES git_sources(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('bearer')),
  ciphertext    BLOB NOT NULL,
  iv            BLOB NOT NULL,
  key_version   INTEGER NOT NULL DEFAULT 1,
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- Per-user creds for write-back attribution (user_bearer PAT or user_oauth).
-- Kept separate from user_credentials (which FKs upstream_servers).
CREATE TABLE git_user_credentials (
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  git_source_id TEXT NOT NULL REFERENCES git_sources(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('bearer','oauth')),
  ciphertext    BLOB NOT NULL,
  iv            BLOB NOT NULL,
  key_version   INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (user_id, git_source_id)
);

-- Link a document to its git origin. NULL git_source_id ⇒ ordinary doc.
ALTER TABLE documents ADD COLUMN git_source_id  TEXT REFERENCES git_sources(id) ON DELETE SET NULL;
ALTER TABLE documents ADD COLUMN git_path       TEXT;     -- repo-relative, e.g. 'docs/setup.md'
ALTER TABLE documents ADD COLUMN git_blob_sha   TEXT;     -- last-synced blob/object sha
ALTER TABLE documents ADD COLUMN git_commit_sha TEXT;     -- commit the blob was read at
ALTER TABLE documents ADD COLUMN git_synced_at  INTEGER;
ALTER TABLE documents ADD COLUMN git_sync_state TEXT
      CHECK (git_sync_state IN ('clean','local_edits','pr_open','conflict'));

-- One doc per (source, path). Partial unique so non-git docs (NULL) don't clash.
CREATE UNIQUE INDEX idx_documents_git_origin
  ON documents(git_source_id, git_path)
  WHERE git_source_id IS NOT NULL AND deleted_at IS NULL;

-- Open PRs/MRs we created, so the SPA shows status and subsequent edits
-- update the same branch instead of opening a new PR.
CREATE TABLE git_pull_requests (
  id              TEXT PRIMARY KEY,
  git_source_id   TEXT NOT NULL REFERENCES git_sources(id) ON DELETE CASCADE,
  doc_id          TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  branch_name     TEXT NOT NULL,            -- ctxlayer-managed head branch
  provider_pr_id  TEXT NOT NULL,            -- PR number / MR iid / PR id
  url             TEXT NOT NULL,            -- deep link to the PR/MR
  state           TEXT NOT NULL DEFAULT 'open'
                  CHECK (state IN ('open','merged','closed','error')),
  opened_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
  base_commit_sha TEXT,                     -- commit the edit was based on
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_git_pr_doc ON git_pull_requests(doc_id, state);
