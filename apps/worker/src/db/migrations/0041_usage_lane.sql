-- Which MCP lane served a tool call, and for which client.
--
-- /mcp is served by two lanes that coexist: the `session` lane (McpAgent, a
-- Durable Object per MCP session, protocol revisions up to 2025-11-25) and
-- the `stateless` lane (a fresh server per request, revision 2026-07-28).
-- Recording the lane, the negotiated protocol revision and the client's
-- self-reported name on every usage event is what lets the usage pages
-- compare the two and show which clients still depend on which.
--
-- All three are nullable: rows written before this migration, and queue
-- messages already in flight when it deploys, carry none of them. The read
-- side reports those as an "unknown" lane rather than guessing.
--
-- Plain ADD COLUMNs on a leaf table (nothing references usage_events), so no
-- rebuild is involved — see conventions §G1 for why that matters on D1.
-- `client_name` is client-supplied text: the writer caps its length, and it is
-- only ever rendered as text.
ALTER TABLE usage_events ADD COLUMN lane TEXT CHECK (lane IN ('session', 'stateless'));
ALTER TABLE usage_events ADD COLUMN protocol_version TEXT;
ALTER TABLE usage_events ADD COLUMN client_name TEXT;
