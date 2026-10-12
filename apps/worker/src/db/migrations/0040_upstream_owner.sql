-- User-private ("owned") upstreams.
--
-- An upstream with `owner_user_id` set is visible to that one user only, on
-- every path: the MCP catalogue, /app/upstreams, and the admin Upstreams page
-- (other admins never see it). Visibility grants, per-tool ACL rules and
-- skill/doc attachments are refused on an owned upstream — the owner is its
-- only audience, so a grant could only ever widen it. NULL = an ordinary
-- org upstream gated by `upstream_visibility`, exactly as before.
--
-- "Share with org" clears the owner (one way); grants then apply as usual.
--
-- ADD COLUMN, not a rebuild: upstream_servers is a referenced parent (see
-- G-conventions §G1). Deleting the owner cascades the upstream away, and every
-- child of upstream_servers already cascades in turn.
ALTER TABLE upstream_servers ADD COLUMN owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE;

CREATE INDEX idx_upstream_servers_owner
  ON upstream_servers(owner_user_id) WHERE owner_user_id IS NOT NULL;
