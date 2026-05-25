-- Add a `folder` path string to documents. NULL = root. Folder
-- existence is derived at read time from the populated set of
-- paths (no separate folders table — empty folders by definition
-- can't exist with this storage choice).
--
-- Format conventions (enforced at the request layer in
-- packages/shared/src/docs-types.ts, not in SQL — kept out of the
-- CHECK so error messages can be user-friendly):
--   * leading '/' (absolute), no trailing '/'
--   * segments are [a-z0-9-]+ separated by '/'
--   * max depth 5, max total length 200
ALTER TABLE documents ADD COLUMN folder TEXT;

-- The tree-build query is `SELECT DISTINCT folder FROM documents
-- WHERE folder IS NOT NULL` and the filtered list query is
-- `WHERE folder = ?`. Both benefit from this index.
CREATE INDEX idx_documents_folder ON documents(folder) WHERE folder IS NOT NULL;
