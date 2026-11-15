-- First-result playbook hint ledger for the STATELESS MCP lane.
--
-- The first successful result from an upstream carries a one-line pointer to
-- the org playbooks attached to it (docs/plan/O-result-skill-hint.md). "First"
-- needs memory. The session lane keeps it in the session Durable Object's own
-- SQLite (once per upstream per MCP session); the stateless lane has no
-- session and no Durable Object, so its memory lives here: once per upstream
-- per (user, client) per re-arm window. `hinted_at` (unix seconds) is the
-- last time the hint was delivered; a later call re-delivers once the window
-- has passed, which is what stands in for "a new session".
--
-- `client_key` is the short hash the lane also uses as the usage
-- `session_id` (user id + OAuth client id), so one person's Claude Desktop
-- and Claude Code are hinted independently.
--
-- No FK to users / upstream_servers: this is a disposable ledger pruned by
-- age (nightly cron), and a NOT NULL child of either parent would only add a
-- parent-rebuild landmine (conventions §G1) for integrity nothing reads.
CREATE TABLE mcp_hint_ledger (
  user_id     TEXT NOT NULL,
  client_key  TEXT NOT NULL,
  upstream_id TEXT NOT NULL,
  hinted_at   INTEGER NOT NULL,
  PRIMARY KEY (user_id, client_key, upstream_id)
);

-- The nightly prune's read: oldest first.
CREATE INDEX idx_mcp_hint_ledger_hinted_at ON mcp_hint_ledger(hinted_at);
