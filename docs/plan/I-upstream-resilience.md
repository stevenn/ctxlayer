# Upstream resilience: long-running calls + oversized responses — deep dive

> **Status (2026-05-30): WI-1, WI-4, WI-5 and I7 landed. WI-6 (async
> submit→poll) landed 2026-07-12 — see §I9.** WI-2 (Driver-side progress
> emission) is an ask to Driver, not ctxlayer code; WI-3 (raising the global
> ceilings) remains open. The async pattern shipped by moving the slow call to a
> queue consumer, which sidesteps the Durable Object wall-clock question rather
> than answering it. Implemented: per-upstream
> timeout overrides (`authConfig.timeouts`, clamped at the admin REST boundary
> and re-clamped in `http-client.ts`), a response-size guardrail
> (`UPSTREAM_MAX_RESPONSE_BYTES` 256 KB default + `authConfig.maxResponseBytes`
> override, truncation notice in `tools-proxy.ts`), and durable timeout/
> truncation analytics (migration `0014_usage_resilience.sql`, surfaced on
> `/app/admin/usage`).
>
> **Follow-up (2026-05-31): WI-5 usage enqueue made crash-safe.** Prod showed
> recurring `waitUntil() tasks did not complete within the allowed time…`
> warnings on `POST /mcp` (outcome `ok`). Root cause: the per-tool-call usage
> enqueue was a fire-and-forget `ctx.waitUntil(USAGE_QUEUE.send(...))`; once the
> streaming MCP response ended, the trailing send could be cancelled before it
> settled — dropping the usage row (a slow/abandoned upstream call, e.g. Driver,
> made it likely). Fix: tool calls now **stage** the pre-computed event in the
> DO's own SQLite outbox synchronously (`usage/outbox.ts`), and an idempotent
> `flushUsageOutbox` alarm drains it to the queue in its own invocation
> (`mcp/session-do.ts`). Durability no longer rides the request's post-response
> grace window; a cut-short drain just leaves rows for the next pass. Delivery is
> at-least-once, so `queues/usage-consumer.ts` now acks duplicate event ids
> (the atomic batch in `writeUsageEvent` means no double-count).
>
> Originally written from a live reproduction against the **Driver** upstream
> (`driver.gather_task_context`, `driver.get_code_map`). The per-call timeout +
> progress-keepalive machinery this doc builds on was **already shipped** (M4);
> the gap was that it did not protect a *silent* long-running upstream, and there
> was **no response-size guardrail at all**. This doc captures the diagnosis and
> the work items.

Related: [C — Upstream proxy mechanics](C-upstream-proxy.md) (note: C§C4's
error taxonomy still says "60s wall" — that is **stale**, see [I7](#i7-doc-drift-to-fix)).

---

## I1. What happened (the reproduction)

Two failures while an agent used the `driver` upstream through ctxlayer:

1. **`gather_task_context` (broad task) timed out.** The agent received:
   ```
   upstream_timeout: driver.gather_task_context — MCP error -32001: Request timed out (ref=a229df9a)
   ```
   The *same tool with a narrow task description returned fine in well under a
   minute.* So the connection/auth/tool are healthy — this is **latency vs the
   per-call ceiling**, not an outage.

2. **`get_code_map` (whole-repo) returned 1,414,990 chars.** ctxlayer relayed
   it verbatim; the **agent client's** own context guard rejected it. Scoped
   calls (`relative_directory_path` + `max_depth`/`max_nodes`) returned 2 and
   17 nodes and were fine. (A client-side parameter mistake — passing `path`
   instead of `relative_directory_path` — made the blast radius worse, but the
   ctxlayer-relevant fact stands: **we have no size ceiling on relayed
   responses**.)

Both are upstream-shape problems — some Driver tools are slow, and some return
very large payloads — that ctxlayer should absorb rather than pass straight
through to the agent.

---

## I2. Where the error actually comes from (current code)

The error string is **ours**, produced by `formatUpstreamError` in
[`apps/worker/src/mcp/upstream-error.ts`](../../apps/worker/src/mcp/upstream-error.ts):

```
userMessage: `${code}: ${args.slug}.${args.toolName}${tail} (ref=${refId})`
//            code = 'upstream_timeout' when status === 'timeout'
//            tail = ' — <sanitised raw message>'  →  ' — MCP error -32001: Request timed out'
```

The flow that gets there:

- [`apps/worker/src/upstream/http-client.ts`](../../apps/worker/src/upstream/http-client.ts)
  `UpstreamHttpClient.callTool()` calls the MCP SDK `client.callTool(...)` with
  `RequestOptions`:
  ```ts
  timeout: UPSTREAM_CALL_TIMEOUT_MS,          // 150_000  — base inactivity window
  onprogress: () => {},                        // makes the SDK send a progressToken
  resetTimeoutOnProgress: true,                // each progress ping rearms `timeout`
  maxTotalTimeout: UPSTREAM_MAX_CALL_TIMEOUT_MS // 300_000 — hard ceiling regardless of progress
  ```
- When the SDK's `AbortController` fires it throws `RequestTimeoutError`
  ("MCP error -32001: Request timed out").
- [`apps/worker/src/mcp/tools-proxy.ts`](../../apps/worker/src/mcp/tools-proxy.ts)
  `registerTool`'s handler catches it; `isTimeoutError()` (regex
  `/timeout|timed out|deadline/i`) maps it to `status='timeout'`; it logs with a
  `ref=` id, calls `formatUpstreamError`, returns `errText(userMessage)`, and
  records a `usage_events` row with `status='timeout'`.

So the timeout is enforced **client-side inside ctxlayer**, at the MCP-SDK
per-call level. There is no separate ctxlayer "proxy timeout" layer and the
agent's own MCP client did not fire first.

**The constants today** (already raised once from a flat 60s — the comment in
`http-client.ts:31-37` literally cites Driver's 1–3 min `gather_task_context`):

| Constant | Value | Meaning |
|---|---|---|
| `UPSTREAM_LIST_TIMEOUT_MS` | 60s | `tools/list` fail-fast cap |
| `UPSTREAM_CALL_TIMEOUT_MS` | 150s | base **inactivity** window per `tools/call` |
| `UPSTREAM_MAX_CALL_TIMEOUT_MS` | 300s | hard ceiling per `tools/call` |

---

## I3. Root cause: the keepalive is a no-op for a *silent* upstream

The design intent is sound: `resetTimeoutOnProgress` means a long-but-alive
call should keep rearming the 150s window on each progress notification and only
ever die at the 300s hard cap. **But that only works if the upstream actually
emits `notifications/progress` frames.**

Driver's `gather_task_context` runs a single long server-side computation and
(as far as the reproduction shows) sends **no progress notifications**. With no
pings:

- `resetTimeoutOnProgress` never triggers,
- the **150s inactivity window is the effective wall clock**, and
- a broad task that computes silently for >150s trips `UPSTREAM_CALL_TIMEOUT_MS`
  — exactly what we saw, while the narrow (<150s) task succeeded.

So the progress-keepalive we shipped does nothing for the one upstream it was
written for. Two independent levers fix this — one we own, one Driver owns.

---

## I4. Ownership split

| Failure | Root cause | Primary owner | Lever |
|---|---|---|---|
| `gather_task_context` timeout | 150s inactivity cap is the real ceiling for a silent upstream; keepalive inert | **ctxlayer** (raise/scope the cap) → **Driver** (emit progress, then 300s cap governs) | [WI-1](#wi-1-per-upstream-timeout-overrides), [WI-2](#wi-2-driver-side-emit-progress), [WI-3](#wi-3-revisit-the-global-ceilings-only-after-i52) |
| `get_code_map` 1.4 MB | no response-size guard anywhere in the proxy | **ctxlayer** (cap/guard) → Driver (saner default page size) | [WI-4](#wi-4-response-size-guardrail) |

---

## I5. Constraints that shape the fix

Do not just bump `UPSTREAM_CALL_TIMEOUT_MS` to 300s and move on. Three real
limits:

1. **`McpSessionDO` processes requests serially** (see [C§C7](C-upstream-proxy.md#c7-concurrent-tool-calls-within-one-session)).
   A 150–300s call **blocks the entire session** — every other `tools/call`,
   including built-ins, queues behind it. A blanket high timeout makes one slow
   upstream freeze the agent. This is the strongest argument for **per-upstream**
   scoping (WI-1) rather than a global bump.
2. **Cloudflare Workers / DO wall-clock.** A request that sits ~300s waiting on
   an outbound fetch needs to be confirmed against the platform's request
   duration limits for Durable Objects. CPU time is low (idle TCP read is wall,
   not CPU) but total request wall-clock is the question. **Verify before
   raising the hard cap.** (C§C5/risks historically assumed a 60s wall cap; that
   assumption is what we are revisiting.)
3. **Usage tokenisation cost.** `recordUsage` → usage consumer tokenises the
   response with tiktoken. A 1.4 MB response ≈ hundreds of thousands of tokens
   tokenised in the queue consumer per call — wasteful and a reason to cap size
   (WI-4) independent of the agent-context concern.

---

## I6. Work items

### WI-1: Per-upstream timeout overrides

Make the three timeout constants **per-upstream**, defaulting to today's
global values, so `driver` can get a long inactivity window without making every
other upstream hang for 150s on a stall.

- **Schema.** `upstream_servers.auth_config` is already JSON
  (`authConfig.http`). Add an optional `authConfig.timeouts`:
  ```jsonc
  "timeouts": { "callMs": 240000, "maxCallMs": 300000, "listMs": 60000 }
  ```
  No migration needed (JSON column). Validate in the admin upstream Zod schema;
  clamp to a sane max (e.g. ≤ the platform wall-clock limit confirmed in
  [I5.2](#i5-constraints-that-shape-the-fix)).
- **Threading.** `UpstreamHttpClient` already receives the `UpstreamConnection`
  (`http-client.ts:59-62`). Read `conn.authConfig.timeouts` in `callTool` /
  `listTools` and fall back to the module constants. Keep the constants as the
  documented defaults.
- **Admin UI.** Optional advanced field in the upstream drawer
  (`apps/web/src/routes/admin/upstreams/DetailsSection.tsx`) — "Long-call timeout (s)" with a
  helper noting the serial-DO blast radius. Fine to ship config-only first and
  add UI later.
- **Why per-upstream, not global:** [I5.1](#i5-constraints-that-shape-the-fix)
  — one slow upstream must not freeze the whole session.

### WI-2: Driver-side — emit progress

The real fix for `gather_task_context`. If Driver emits periodic
`notifications/progress` during its 1–3 min compute, the
`resetTimeoutOnProgress` logic **already in `http-client.ts`** keeps the call
alive on each ping and only the 300s hard cap applies — no ctxlayer change
needed beyond confirming pass-through.

- **Ask Driver for:** periodic `notifications/progress` (any cadence < the
  inactivity window, e.g. every 20–30s) for long-running tools, ideally with
  monotonic `progress`/`total` so we could surface a percentage later.
- **Confirm on our side:** the SDK forwards the `progressToken` (it does when
  `onprogress` is set — it is) and that streamable-HTTP transport delivers the
  notification frames through to the `onprogress` callback. Add a temporary
  counter/log in the `onprogress` body to verify frames arrive once Driver ships
  them.
- **Stretch:** make the `onprogress` no-op forward progress to the agent's own
  `progressToken` so the *agent* sees liveness too (today the callback is a
  deliberate no-op — keepalive only).
- **Diagnostic to settle which cap fired** (150s vs 300s) for `ref=a229df9a`:
  grep the worker log for that id and read the elapsed time. ~150s ⇒ inactivity
  window (silent upstream, confirms this whole section). ~300s ⇒ hard cap (even
  with progress it's genuinely too long → Driver must get faster or go async).

### WI-3: Revisit the global ceilings (only after I5.2)

If Driver can't emit progress soon, the interim mitigation is bounded by
[I5](#i5-constraints-that-shape-the-fix):

- Consider raising `UPSTREAM_CALL_TIMEOUT_MS` toward the 300s hard cap **only**
  for upstreams that opt in via WI-1 — not globally.
- First **verify the DO request wall-clock limit** (I5.2). If the platform caps
  request duration below 300s, the hard cap is aspirational and the honest fix
  is async (WI-5), not a bigger number.

### WI-4: Response-size guardrail

There is no size limit on relayed `tools/call` results today —
`UpstreamHttpClient.callTool` returns `res.content` as-is and `tools-proxy`
stringifies it. Add a guard so an oversized upstream payload degrades
gracefully instead of nuking the agent's context (and wasting tokeniser cost):

- **Cap + signal.** Define `UPSTREAM_MAX_RESPONSE_BYTES` (proposal: ~256 KB,
  tunable; per-upstream override via the same `authConfig` channel as WI-1).
  When `safeJson(result.content)` exceeds it, replace the body with a structured
  truncation notice — byte size, the cap, and (where the tool supports it) a
  hint to paginate/scope — rather than forwarding megabytes. Mark the
  `usage_events` row (see WI-5).
- **Keep it transport-honest.** C§C5 says we stream and never `.text()` the
  body; today's SDK `callTool` actually materialises `content` in memory, so the
  cap is applied on the assembled result. If/when true streaming passthrough
  lands, the cap moves to a byte-counter in the stream.
- **Driver-side (secondary):** `get_code_map` treating `max_nodes: 0` as
  "unlimited" at repo root is a sharp edge; a sane default page size upstream
  would prevent the 1.4 MB blob at the source. Worth raising, but WI-4 protects
  us regardless of upstream behaviour.

### WI-5: Observability

- `usage_events.status` already carries `'timeout'`
  (`0003_usage.sql` CHECK + `tools-proxy` mapping). Add a query/admin-usage
  surface for **timeout rate per upstream/tool** so we can see Driver-class
  slowness without grepping logs.
- Add a marker for truncated-oversize responses from WI-4 (either a new
  `status` value — needs a CHECK migration — or a boolean in the usage event
  meta; prefer the latter to avoid a migration).
- The `ref=` correlation id (`newCorrelationId`) already ties the agent-facing
  message to the server log; keep that contract.

---

## I7. Doc drift to fix

- [C§C4](C-upstream-proxy.md#c4-error-surface-taxonomy) lists "Upstream timeout
  (60s wall)" → `-32603`. Reality: the cap is **150s base / 300s hard**
  (`http-client.ts`), and the agent-facing code is **`upstream_timeout: …
  (ref=…)`** text via `formatUpstreamError`, not a `-32603` JSON-RPC error.
  Update C§C4 when WI-1/WI-3 land.
- C§C5 / PLAN.md "Risks" reference a 60s wall cap as a CPU-pressure mitigation —
  reconcile with the actual constants and the I5.2 wall-clock verification.

---

## I8. Suggested order

1. **WI-5 (cheap):** timeout-rate visibility — confirms how often this bites and
   for which tools, before investing.
2. **WI-1:** per-upstream timeout override (config + client threading). Unblocks
   giving `driver` headroom safely.
3. **WI-2:** raise with Driver in parallel — the durable fix; needs no further
   ctxlayer code, only verification.
4. **WI-4:** response-size guardrail — independent, protects context + tokeniser.
5. **WI-3:** only if Driver can't ship progress and **after** the DO wall-clock
   check.
6. **WI-7 doc fixes** alongside whichever of the above touches the constants.

## I9. Open questions / decisions to make

- **DO request wall-clock ceiling** on the current Workers plan — hard number?
  (Gates WI-3 and the WI-1 clamp.)
- **Default response cap** — 256 KB a reasonable global default, or per-upstream
  only? (Driver `get_code_map` legitimately returns large maps when scoped
  intentionally.)
- **Async/job pattern** for genuinely multi-minute tools — **SHIPPED
  (2026-07-12)** as WI-6 below. The trigger turned out not to be "Driver
  exceeds 300s" but "an *interactive client* caps the request below the tool's
  runtime": Claude Desktop hard-caps `tools/call` at ~180s and does not reset
  on progress, so no server-side keepalive (transport SSE comments, the
  `notifications/progress` heartbeat) can extend it. A synchronous 2-3 min tool
  simply cannot fit. See WI-6.

### WI-6: Async submit→poll for slow tools (shipped 2026-07-12)

A native tool listed in an upstream's `authConfig.asyncTools` (config-only, no
migration — same JSON channel as WI-1 `timeouts`) is no longer run inline. The
proxy (`mcp/tools-proxy.ts submitAsyncJob`) enqueues a `ctxlayer-jobs` message
and returns a job token immediately; the queue consumer
(`queues/jobs-consumer.ts`) re-dials the upstream with the caller's creds and
runs the full `tools/call`, storing the result on an `async_jobs` row
(migration `0032`). The `poll_task` / `list_tasks` built-ins read it back.

- **Why a queue, not a longer DO request:** this sidesteps the I5.2 / I9
  *DO wall-clock* question entirely — a background queue-consumer invocation has
  ~15 min wall-clock, and the submit/poll DO requests each return in <2s, well
  under any client cap. The serial-DO blast radius (I5.1) also disappears: the
  long call no longer runs in the session's DO.
- **Retry-warm:** the job is keyed by `sha256(user, upstream, tool, args)`, so a
  natural re-run of the same call returns the cached result (TTL 15 min) with
  zero polling — the whole `runUpstreamCall` (size guard + error sanitise) is
  shared with the inline path so the two can't drift.
- **Trigger is uniform** (async-eligible tool → always async, every client). A
  client-aware sync fast-path for reset-on-progress clients (Claude Code,
  claude.ai) is the noted easy follow-up.
- **Config:** set `driver` → `authConfig.asyncTools = ["gather_task_context"]`.
