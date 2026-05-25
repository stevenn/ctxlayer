# Upstream proxy mechanics — deep dive

> **M4 scope (2026-05-25).** M4 ships **HTTP/SSE upstreams only**. Anything
> marked 🅿️ below — Daytona sandbox wake/create paths, sandbox-quota error
> codes, the `stdio_daytona` row in `list_upstreams()` — is parked alongside
> [B](B-daytona-stdio.md) until a real stdio MCP upstream is on the roadmap.

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
| Tool description >1024 chars | Truncated with `…` to keep client UIs sane. |
| Upstream renames a tool between catalogue refreshes | Old name disappears from next `tools/list`; outstanding `tools/call` returns `{code:-32601, message:"tool no longer available"}`. |

### C3. Lazy connect — cost analysis

| Path | Sync work in tool/call hot path |
|---|---|
| First `tools/call` to upstream `notion__create_page` (HTTP) | DNS + TLS + MCP `initialize` + tool dispatch. ~150-400ms warm; ~600ms cold. Acceptable. |
| 🅿️ First `tools/call` for `github_stdio__create_issue` (Daytona) | Sandbox wake (~150-300ms if existing) OR create (~500-1500ms cold) + supergateway start + tool dispatch. Cold path can exceed 1s; mitigated by snapshot pre-baking + concurrent sandbox start triggered by a hint on `tools/list` (see below). |
| Subsequent calls within session | Re-use Client. ~30-80ms. |
| 🅿️ Subsequent calls after Daytona auto-stop | Wake (~150-300ms) — cheap. |

🅿️ Optimisation (parked with the Daytona track): when a session opens, kick off a `ctx.waitUntil` that starts (not creates) sandboxes for any stdio upstream the user has credentials for. Doesn't block `initialize`, but the first real tool/call usually finds the sandbox already running. Disabled by default; opt-in per upstream (`auth_config.warmOnSessionStart=true`) to avoid spending sandbox-seconds when the agent never actually uses that upstream.

### C4. Error surface taxonomy

| Layer | What client sees |
|---|---|
| Upstream returns JSON-RPC error | Passed through verbatim, `code` preserved. |
| Upstream returns `result` with `isError:true` | Passed through verbatim. |
| Upstream timeout (60s wall) | `{code:-32603, message:"Upstream {slug} timed out"}` |
| Upstream HTTP 5xx / connection refused | `{code:-32603, message:"Upstream {slug} unavailable: <category>"}` (category in `data.category`) |
| Credential refresh failed (e.g. revoked refresh token) | `{code:-32001, message:"Reauthenticate {slug}: visit https://.../upstreams"}` |
| 🅿️ Daytona create failed (quota) | `{code:-32002, message:"Sandbox quota exceeded; ask admin"}` |
| 🅿️ Daytona create failed (snapshot missing) | `{code:-32003, message:"Upstream {slug} not provisioned"}` (admin error) |
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
- A 60s `AbortController` wraps the upstream fetch; on abort we send a final `{error: -32603, timeout: true}` frame.

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
  // 🅿️ parked — only emitted once the Daytona track ships:
  { "slug": "github_stdio", "displayName": "GitHub (stdio)", "transport": "stdio_daytona",
    "connected": true, "sandboxState": "idle" }
]
```

Agents call this proactively to know which proxied tools they can rely on. Disconnected ones include a deep link the agent can give the user.

---

