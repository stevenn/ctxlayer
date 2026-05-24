-- Track how many chunks a doc's current revision produced. The
-- reindex consumer reads the previous value before upserting to
-- decide which chunks to delete (idx in [newCount, prevCount-1])
-- so Vectorize never holds orphan chunks from a shrunk doc.
--
-- Defaults to 0 for the rows that pre-date this migration; the
-- next reindex sets a real value. There is no migration backfill
-- because the reindex pipeline is idempotent — saving a doc once
-- recomputes the count.

ALTER TABLE documents ADD COLUMN chunk_count INTEGER NOT NULL DEFAULT 0;
