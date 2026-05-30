# B — Stdio upstreams via an external HTTP bridge (bring-your-own-bridge)

> ctxlayer proxies **HTTP/SSE** MCP upstreams directly. It does **not** run,
> sandbox, or manage stdio MCP subprocesses. To use a stdio MCP server, the
> operator fronts it with their own stdio↔HTTP bridge and registers the
> resulting HTTP URL as an ordinary `streamable_http` upstream.

## The model

A stdio MCP server is a local subprocess speaking JSON-RPC over stdin/stdout.
The edge runtime can't spawn or host subprocesses, so ctxlayer never tries.
Instead:

1. **You run a bridge.** On infrastructure you control (a VM, a container, a
   long-running host), run a stdio↔HTTP bridge such as
   [`supergateway`](https://github.com/supercorp-ai/supergateway) — or any
   equivalent tool — wrapping the stdio MCP command. The bridge converts
   stdio ↔ Streamable HTTP so it presents a normal MCP HTTP endpoint.
2. **You expose it.** Give the bridge a stable, public **HTTPS** URL.
3. **You register it.** In ctxlayer admin, add it as a regular
   `streamable_http` upstream (or `sse` if your bridge only speaks SSE).
   From ctxlayer's side it is indistinguishable from any other HTTP upstream.

There is **no ctxlayer-managed sandbox lifecycle**: no per-user containers,
no snapshot baking, no cold-start pool, no extra secrets.

## Per-user credentials

The bridge URL is registered like any HTTP upstream, so per-user auth uses the
existing credential strategies unchanged:

- `user_bearer` — user pastes a token; sealed at rest, injected per request.
- `user_oauth` — per-user OAuth (DCR + PKCE) to the upstream.
- `none` — public upstream.

How the underlying stdio process receives those credentials (env var, header
passthrough, per-session args) is the **bridge operator's** responsibility,
configured where you run the bridge — outside ctxlayer.

## Operator checklist

- Run the bridge on a host you trust; keep the stdio binary and its secrets
  there, not in ctxlayer.
- Terminate TLS / front the bridge with HTTPS. The admin upstream handler
  rejects non-HTTPS URLs and loop-back to ctxlayer's own hostnames.
- Pick the credential strategy that matches the upstream and register the URL.
- Treat the bridge as the gated-execution surface it is: scope its network
  egress and lock down who can reach it.

## Pluggability

The proxy is built around a generic `UpstreamClient` interface
(`apps/worker/src/upstream/*.ts`), so additional transports can be added later
without special-casing. Today the shipped transports are `streamable_http` and
`sse`; stdio is covered entirely by the bring-your-own-bridge approach above.
