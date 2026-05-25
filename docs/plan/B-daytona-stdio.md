# Daytona stdio bridge — concrete recipe

### B1. Snapshot Dockerfile pattern

One Dockerfile per supported stdio MCP server. Base image is shared.

`infra/daytona-snapshots/base/Dockerfile`:
```dockerfile
FROM node:22-alpine
RUN apk add --no-cache python3 py3-pip dumb-init curl
RUN npm install -g supergateway@latest
EXPOSE 8080
ENTRYPOINT ["dumb-init", "--"]
# subclasses override CMD
```

`infra/daytona-snapshots/github-stdio/Dockerfile`:
```dockerfile
FROM ctxlayer/base:latest
RUN npm install -g @modelcontextprotocol/server-github@pinned-version
ENV BRIDGE_PORT=8080
# supergateway wraps the stdio process and exposes Streamable HTTP on 8080
CMD ["sh", "-c", "supergateway --stdio 'mcp-server-github' --port ${BRIDGE_PORT} --transport streamableHttp"]
```

Bridge choice rationale: **supergateway** is the canonical Node-based stdio↔HTTP MCP bridge. Picked over `mcp-proxy` (Python) because most stdio MCP servers are Node, base image is smaller, and we get one runtime instead of two. `mcp-proxy` remains an option for Python-only stdio servers (`mcp-server-fetch` etc.) via a separate base image.

### B2. Snapshot baking pipeline

`infra/daytona-snapshots/build-and-push.ts`:
1. For each subdirectory: `docker build`, tag with `${slug}:${gitsha}` and `${slug}:latest`.
2. Push to Daytona's registry (or a public registry referenced from Daytona).
3. Call Daytona's snapshot-create API to register the new image as a snapshot, returning a `snapshotId`.
4. Update `upstream_servers.auth_config.snapshotId` for that slug (admin opt-in to roll forward).
5. Output a small summary table: `slug | old snapshot | new snapshot | size | server version`.

CI workflow runs this nightly + on push to `infra/daytona-snapshots/**` so snapshots stay close to current.

### B3. Env-var substitution

`upstream_servers.auth_config.envTemplate` for the GitHub stdio example:
```json
{
  "GITHUB_TOKEN": "${creds.access_token}",
  "GITHUB_ENTERPRISE_URL": "${upstream.auth_config.enterprise_url}",
  "MCP_DEBUG": "false"
}
```

`apps/worker/src/upstream/daytona.ts` resolves each `${...}` against:
- `creds.*` — the decrypted user_credentials JSON (or shared_bearer auth_config).
- `upstream.*` — non-secret upstream config.
- `user.*` — sanitised user fields (email, idp_sub) for upstream servers that want a calling-user identity.

Resolved env is passed to Daytona's sandbox-create API as the container's environment. The Worker never logs the resolved env.

### B4. Sandbox lifecycle in detail

```
First tool call for stdio_daytona upstream
  -> McpSessionDO.callUpstream(upstreamId, ...)
     -> ensureSandbox(userId, upstreamId)
        SELECT * FROM sandbox_sessions WHERE user_id=? AND upstream_id=?
        if row exists AND state IN ('running','idle'):
          POST {daytona}/sandboxes/{id}/start  (no-op if already running)
        else:
          quota check: count(running) for user < MAX_SANDBOXES_PER_USER
          POST {daytona}/sandboxes {snapshotId, env, autoStopMinutes}
          INSERT/UPDATE sandbox_sessions row, state='starting'
        poll GET {daytona}/sandboxes/{id} until state=='running' (timeout 5s, sub-90ms typical)
        UPDATE sandbox_sessions SET state='running', last_active_at=now
        return baseUrl = `https://${BRIDGE_PORT}-${sandboxId}.proxy.daytona.app`

  -> open Streamable HTTP Client to baseUrl, attach Daytona proxy auth header
  -> proxy the JSON-RPC call
  -> ctx.waitUntil(daytona.refreshActivity(sandboxId))
  -> ctx.waitUntil(USAGE_QUEUE.send({...}))
```

Concurrency: McpSessionDO is single-threaded per session (it IS a DO), so two parallel tool calls inside one session serialise through the same `ensureSandbox`. Across sessions for the same user we use a D1 row-level lock (`UPDATE ... WHERE state='starting'` returning row count) to dedupe creates.

### B5. Keep-alive vs. Workers wall-clock

- Each tool call invokes `refreshActivity` via `waitUntil`. That keeps the Daytona auto-stop timer at the configured `idleTimeoutSeconds` (default 600s).
- Workers wall-clock doesn't constrain *the sandbox*; it constrains how long the Worker handles a single MCP request. The sandbox keeps running between requests.
- For a session where the agent goes silent for >`idleTimeoutSeconds`, Daytona auto-stops. The next tool call wakes it (start, not create) — typically faster than cold create. The Worker handles this transparently.

### B6. Per-user vs. pooled — locked decision

- **Per-user** sandboxes. Reason: stdio MCP servers cache auth state (cookies, local sqlite, oauth tokens). A pooled sandbox would either need per-call state injection (most servers don't support it) or would leak state across users. Per-user is safer and matches mcp-front's model.
- Exception: a single shared "catalogue" sandbox is started briefly by cron to call `tools/list` and refresh the cached catalogue. No user creds are loaded into it. It auto-stops minutes after the cron tick.

### B7. Fallback when Daytona is unhealthy

Circuit breaker in `apps/worker/src/upstream/daytona.ts`:
- Per-upstream sliding-window counter in DO storage of the `McpSessionDO`. >3 consecutive failures within 60s → open circuit for 30s. While open, `tools/call` on that upstream returns `{ isError: true, content: [{type:'text', text:'Stdio upstream temporarily unavailable.'}] }` immediately without contacting Daytona.
- Admin UI surfaces circuit state per upstream.

### B8. Cost projection sketch

Daytona Cloud's published pricing model is per-sandbox-second of active CPU. Worked example for a team of 20:
- Assume 5 stdio upstreams enabled, average user has 2 stdio sessions active during work hours (8h).
- Peak concurrent active sandboxes ≈ 20 × 2 = 40.
- At ~$0.05/hour per small sandbox (estimate; confirm against current pricing): 40 × 8 × $0.05 ≈ $16/day ≈ $480/month.
- Aggressive `idleTimeoutSeconds=300` reduces wasted runtime considerably (sandbox sleeps between minutes-long agent pauses).
- Surface estimated cost in admin UI from `(running sandbox-minutes from sandbox_sessions)`.

---

