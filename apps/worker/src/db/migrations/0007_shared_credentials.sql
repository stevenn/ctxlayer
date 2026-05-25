-- Shared credentials for `shared_bearer` upstreams.
--
-- One row per upstream. The token is AES-GCM sealed via the same
-- `crypto/aead.ts` helper used for `user_credentials`. We keep
-- shared creds in a separate table (rather than columns on
-- `upstream_servers`) so:
--   * row reads of upstream metadata stay cheap (no BLOB in every
--     SELECT);
--   * the credential shape mirrors `user_credentials` 1:1, which
--     means rotation tooling and the AEAD ciphertext layout can be
--     reused;
--   * deleting/clearing the shared cred doesn't touch the upstream
--     row's `updated_at`.
--
-- `kind` is enum-shaped to leave room for non-bearer shared creds
-- in the future without a follow-up migration (no use case today —
-- shared OAuth doesn't really exist).
CREATE TABLE upstream_shared_credentials (
  upstream_id  TEXT PRIMARY KEY REFERENCES upstream_servers(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('bearer')),
  ciphertext   BLOB NOT NULL,
  iv           BLOB NOT NULL,
  key_version  INTEGER NOT NULL DEFAULT 1,
  -- Audit trail: who set this token. NULL allowed because admins may
  -- be deleted from `users` while their configured creds linger.
  created_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
