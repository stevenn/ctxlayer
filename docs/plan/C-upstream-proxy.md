# Upstream proxy mechanics — deep dive

> **M4 scope (2026-05-25).** M4 ships **HTTP/SSE upstreams only**. Anything
> A stdio MCP server is reached by registering an operator-run stdio↔HTTP
> bridge as a normal `streamable_http` upstream — see [B](B-stdio-bridge.md).
> There is no dedicated stdio transport, sandbox lifecycle, or quota in
> ctxlayer.

### C1. `tools/list` aggregation algorithm

```
async function listTools(): Promise<Tool[]> {
  const builtins = [searchDocsTool, getDocTool, listUpstreamsTool]
  const enabled = await db.upstreamsEnabledForUser(this.props.userId)
  const proxied: Tool[] = []
  for (const u of enabled) {
    const cached = await db.upstreamToolsCached(u.id)
    if (!cached.length) continue   // skip silently; no entry better than stale ghost
    for (const t of cached) {
      proxied.push({
        name: mangle(u.slug, t.tool_name),
        description: `[${u.display_name}] ${t.description ?? ''}`.slice(0, 1024),
        inputSchema: JSON.parse(t.input_schema),
      })
    }
  }
  return [...builtins, ...proxied]
}
```

Cache freshness is a property of the row (`cached_at`); a session-start refresh job fires `client.listTools()` on each connected upstream and overwrites rows older than 24h. The session does NOT wait on this — the user gets cached tools immediately and the next session benefits from the refresh.

### C2. Namespacing edge cases

| Case | Strategy |
|---|---|
| Upstream tool name contains `__` | Escape upstream side to `_~_`, unescape on dispatch. Documented as a reserved separator. |
| Upstream slug starts with a digit or contains `-` | MCP tool names allow `[a-zA-Z0-9_-]`; we restrict slugs to `[a-z][a-z0-9_]*` (≤24 chars) at admin form validation. |
| Two upstreams export the same tool name | Each is namespaced; collision impossible after mangling. `list_upstreams` and `search_docs` are reserved as built-ins; admins cannot create a slug = built-in name. |
| Upstream namespaces its own tools with its slug (e.g. Notion ships `notion-search`) | `mangleToolName` drops a leading `${slug}-` or `${slug}_` so the surfaced name becomes `notion__search` instead of `notion__notion-search`. Dispatch site closes over `row.tool_name` from the catalogue cache (not over `unmangleToolName`'s output) so the asymmetric collapse is safe — see `apps/worker/src/mcp/tools-proxy.ts:registerTool`. Rule lives in `packages/shared/src/tool-name.ts:collapseSlugPrefix` so the admin SPA tool-browser computes the same name. |
| Tool description >1024 chars | Truncated with `…` to keep client UIs sane. |
| Upstream renames a tool between catalogue refreshes | Old name disappears from next `tools/list`; outstanding `tools/call` returns `{code:-32601, message:"tool no longer available"}`. |

### C3. Lazy connect — cost analysis

| Path | Sync work in tool/call hot path |
|---|---|
| First `tools/call` to upstream `notion__create_page` (HTTP) | DNS + TLS + MCP `initialize` + tool dispatch. ~150-400ms warm; ~600ms cold. Acceptable. |
| Subsequent calls within session | Re-use Client. ~30-80ms. |


### C4. Error surface taxonomy

| Layer | What client sees |
|---|---|
| Upstream returns JSON-RPC error | Passed through verbatim, `code` preserved. |
| Upstream returns `result` with `isError:true` | Passed through verbatim. |
| Upstream timeout (150s base / 300s hard, per-upstream `authConfig.timeouts`) | sanitised text `upstream_timeout: {slug}.{tool} … (ref=…)` via `formatUpstreamError` (not a JSON-RPC `-32603`) |
| Oversized response (> cap; 256 KB default, per-upstream `authConfig.maxResponseBytes`) | sanitised truncation notice; `usage_events.truncated` flagged |
| Upstream HTTP 5xx / connection refused | `{code:-32603, message:"Upstream {slug} unavailable: <category>"}` (category in `data.category`) |
| Credential refresh failed (e.g. revoked refresh token) | `{code:-32001, message:"Reauthenticate {slug}: visit https://.../upstreams"}` |
| Circuit breaker open | `{code:-32004, message:"Upstream {slug} temporarily disabled"}` |

`-3200x` codes are within MCP's reserved server-error range and clients pass them through.

### C5. Streaming long upstream responses

- All transports return responses as `ReadableStream` of JSON-RPC frames.
- Worker code does **not** `.text()` or buffer the upstream body. It pipes:
  ```ts
  const upstreamRes = await upstreamClient.callTool(...)
  return new Response(upstreamRes.body, {
    headers: { 'content-type': 'application/jsonl', ... }
  })
  ```
- CPU time consumed only while bytes are flowing through. Idle wait (TCP read) is wall time, not CPU.
- The MCP SDK's per-call `AbortController` enforces a 150s base inactivity window (rearmed by upstream `notifications/progress`) and a 300s hard ceiling, both overridable per-upstream via `authConfig.timeouts`; on expiry the agent gets a sanitised `upstream_timeout: … (ref=…)` message. The Durable Object request wall-clock limit gating any higher cap is unverified — see docs/plan/I-upstream-resilience.md §I9.
- Response-size guardrail (WI-4): the SDK's `callTool` currently materialises `content` in memory, so a 256 KB default cap (per-upstream `authConfig.maxResponseBytes`) is applied on the assembled result in `tools-proxy.ts`; oversized payloads degrade to a truncation notice rather than being forwarded verbatim. If true streaming passthrough lands, the cap moves to a byte-counter in the stream.

### C6. Subrequest accounting

- Each upstream tool call = 1 outbound `fetch`. Workers paid plan = 1000 subrequests per request, way more than any sane session.
- Catalogue refresh on session start = 1 `client.listTools()` per upstream = 1 fetch each. With 10 upstreams, that's 10 subrequests up-front, well within budget.

### C7. Concurrent tool calls within one session

- `McpSessionDO` is a DO and processes requests serially. An MCP client doing parallel `tools/call` (some do) will queue.
- For high-traffic sessions this serialisation is the bottleneck. Mitigation if needed in v2: have the DO act as a dispatcher and `fetch` to sibling stateless workers for the actual upstream call. For v1 we accept the serial limit — most agents call one tool at a time anyway.

### C8. `list_upstreams()` shape

```jsonc
[
  { "slug": "notion",  "displayName": "Notion",  "transport": "streamable_http",
    "connected": true,  "toolsCount": 7, "lastCalledAt": 1716480000 },
  { "slug": "linear",  "displayName": "Linear",  "transport": "streamable_http",
    "connected": false, "requiresAuth": "user_oauth",
    "connectUrl": "https://ctx.acme.com/app/upstreams?upstream=linear" },
  // a stdio MCP server fronted by an operator-run bridge appears as a
  // normal streamable_http upstream:
  { "slug": "github_stdio", "displayName": "GitHub (stdio)", "transport": "streamable_http",
    "connected": true }
]
```

Agents call this proactively to know which proxied tools they can rely on. Disconnected ones include a deep link the agent can give the user.

---

