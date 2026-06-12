-- Migration 0024: content-hash skip for the reindex pipeline.
--
-- The reindex queue consumer records a hash of what it last successfully
-- indexed for each doc (title + markdown body + team/product tags — the
-- exact inputs that shape the Vectorize chunks), so a redelivered or
-- no-op reindex message can skip the chunk → embed → upsert pipeline.
-- NULL means "never indexed under this scheme" (rows predating this
-- migration); the next successful reindex sets it. The hash is only
-- written after the Vectorize upsert succeeds, alongside chunk_count.
--
-- ALTER TABLE ADD COLUMN only — no parent-table rebuild, so the 0013
-- `PRAGMA foreign_keys=OFF` cascade trap (G-conventions §G1) does not
-- apply.

ALTER TABLE documents ADD COLUMN last_indexed_hash TEXT;
