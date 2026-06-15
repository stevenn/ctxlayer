-- Migration 0027: the inter-doc link graph (OKF bundle link consistency).
--
-- ctxlayer moves to a PATH-BASED, always-consistent doc-link scheme (see
-- docs/plan/N-okf-bundles.md). A doc-to-doc link is authored in the body as a
-- bundle-root-absolute path; this table is the RESOLVED graph, rebuilt from the
-- body on every save:
--
--   source_doc_id  -- the doc whose body contains the link
--   target_doc_id  -- the resolved target, or NULL when the path doesn't
--                     resolve (a DANGLING link — legal per OKF §9 "consumers
--                     MUST tolerate broken links", surfaced in the UI not
--                     rejected). ON DELETE SET NULL so deleting a target turns
--                     its incoming links dangling rather than dropping the row.
--   target_ref     -- the raw href exactly as authored (a path, or a legacy
--                     `/app/docs/<id>` href pre-migration). Part of the PK so a
--                     doc can carry the same target via multiple distinct refs.
--
-- The target_doc_id index powers (a) the editor's "incoming references" panel
-- and (b) move/rename consistency: when a doc's bundle path changes, every
-- source linking to it is found here and its body href is rewritten.
--
-- Child table only (references documents); the §G1 parent-cascade trap does
-- not apply.

CREATE TABLE doc_links (
  source_doc_id TEXT    NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  target_doc_id TEXT             REFERENCES documents(id) ON DELETE SET NULL,
  target_ref    TEXT    NOT NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (source_doc_id, target_ref)
);

CREATE INDEX idx_doc_links_target ON doc_links(target_doc_id);
