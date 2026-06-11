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

---

## Recipe: Azure DevOps with per-user Entra OAuth

Azure DevOps (ADO) is the worked example for **per-user identity over OAuth**,
not pasted PATs. ctxlayer's `user_oauth` static-client mode (pre-registered
Microsoft Entra app — see the OAuth section below) mints a **per-user Entra
access token** scoped to ADO and injects it as the upstream's bearer. There are
two shapes; both use the *same* ctxlayer config and differ only in the URL.

### Why not the obvious paths

- **PAT** works (`user_bearer`) but pushes arcane per-user setup onto every
  user. OAuth moves the one-time work to the operator (register one Entra app).
- **ADO's own OAuth** (`app.vssps.visualstudio.com`) is deprecated (no new apps
  since 2025; full sunset 2026). Entra ID is the path.
- **Entra has no RFC 7591 DCR**, which is why the default `user_oauth` (DCR)
  fails and why Claude/Codex/Cursor can't use the remote ADO MCP directly. The
  static-client mode sidesteps DCR with an operator-registered app.

### The Entra app (operator, once)

Register an Entra **Web** app (confidential — a secret gives durable refresh
tokens; SPA tokens rotate and die fast):

- Redirect URI: `<PUBLIC_BASE_URL>/api/upstreams/oauth/callback` (the single
  global ctxlayer callback).
- Single-tenant is the cleanest consent story.
- The Entra authorize/token endpoints (replace `{tenant}` with your directory
  ID) — used by both shapes:
  - Authorize: `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize`
  - Token: `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token`
- The two shapes differ **only in the token audience/scope** (below).

In ctxlayer admin, create a `streamable_http` upstream, pick auth strategy
**User OAuth — pre-registered (non-DCR)**, and fill the OAuth-client form with
the app's client id + secret, the authorize/token URLs above, and the scopes for
your shape. (The form is provider-agnostic — these ADO values are the recipe.)

### Shape A — remote server, **no bridge** ✅ verified 2026-06-10

Point the upstream URL at `https://mcp.dev.azure.com/{org}` (no `/mcp` suffix —
that 404s). ctxlayer proxies straight through; the per-user Entra bearer is the
auth. Nothing to run.

The remote MCP is its **own** RFC 9728 protected resource — Entra first-party
app **`2a72489c-aab2-4b65-b93a-a91edccf33b8`** (resource `https://mcp.dev.azure.com`),
*distinct* from the classic Azure DevOps REST API (`499b84ac-…`). So:

- **Scope = the resource's own named scopes**, not the ADO-API `.default`. The
  gateway scope `https://mcp.dev.azure.com/Ado.Mcp.Tools` lets you list tools;
  add the read/write families for the tool *calls*. All scopes are
  user-consentable, so **named-scope dynamic consent** works with no
  app-registration permission edits. A sensible read-only starting set (paste
  into the **Scopes** box, one per line or space-separated):

  ```
  https://mcp.dev.azure.com/Ado.Mcp.Tools
  https://mcp.dev.azure.com/work.read
  https://mcp.dev.azure.com/wit.read
  https://mcp.dev.azure.com/repos.read
  https://mcp.dev.azure.com/wiki.read
  https://mcp.dev.azure.com/pipelines.read
  offline_access
  ```

  Add `…/work.write`, `…/repos.write`, etc. for mutating tools.
- **Provision the resource's service principal once**, or `.default`/the portal
  "APIs my org uses" search can't see it and you get `AADSTS650057`:
  `az ad sp create --id 2a72489c-aab2-4b65-b93a-a91edccf33b8`. This just enrolls
  Microsoft's first-party ADO-MCP app into your tenant — it grants nothing on its
  own; per-user consent + the user's own ADO permissions still gate access.
- Avoid `.default` here: it requires the resource pre-listed in the app's
  `requiredResourceAccess` (→ the 650057 loop). Named scopes sidestep that.

> The old "Microsoft may reject a non-Microsoft client id" fear didn't hold — a
> static Entra app connects and lists all tools. Shape B remains the fallback if
> you need the GA local server's exact tool set or offline operation.

### Shape B — local server behind a **per-session** bridge

Run the GA local server (`@azure-devops/mcp`) behind a bridge, and point the
upstream URL at the bridge. The local server's `envvar` auth mode reads a raw
bearer from `ADO_MCP_AUTH_TOKEN` — and the Entra access token ctxlayer injects
*is* a valid ADO bearer.

Here the token must target the **classic Azure DevOps REST API**, not the remote
MCP resource — so the upstream's **Scopes** are different from shape A:

```
499b84ac-1321-427f-aa17-267ca6975798/.default
offline_access
```

The catch: **per-user identity needs a per-session subprocess.** `supergateway`
fixes one process (one identity) at startup, so it can't do this. You need a
thin bridge (~150–250 LoC) that, per MCP session:

1. On `initialize` for a new `Mcp-Session-Id`, reads the inbound
   `Authorization: Bearer <entra-token>` and spawns `@azure-devops/mcp <org>`
   with `ADO_MCP_AUTH_TOKEN` set to it (and `--authentication envvar`).
2. Maps `Mcp-Session-Id → child`; proxies JSON-RPC between the HTTP session and
   the child's stdio.
3. **Pins** the child to the bearer seen at init (reject a later request whose
   bearer differs); reaps the child on session close / idle timeout.

Sketch (illustrative — not production):

```
POST /mcp  (Streamable HTTP)
  ├─ initialize → mint sessionId, read Bearer, spawn child(env: ADO_MCP_AUTH_TOKEN=<bearer>)
  ├─ */tools,calls → pipe frames ⇄ child.stdin/stdout for that sessionId
  └─ close/idle → child.kill(), drop sessionId
```

This host lives in your **ops** repo, never in ctxlayer — the Daytona removal
deliberately got ctxlayer out of subprocess lifecycle. If you ever want hard
per-user isolation (untrusted servers, or a general "any stdio MCP per user"
platform), swap the per-session fork for the **Cloudflare Sandbox SDK**
(Workers + Containers, DO-backed) — more native than re-adding Daytona since
ctxlayer already lives on Cloudflare — but keep the orchestration in the bridge
service.

### Bridge gotchas

- **PAT-mode alternative:** if you connect with `user_bearer` (PATs) instead of
  Entra OAuth, the local server's `pat` mode wants base64 `<email>:<pat>` in
  `PERSONAL_ACCESS_TOKEN`; ADO basic-auth usually ignores the username, so
  `base64(":<pat>")` often works — verify before deciding what users paste.
- **`npx` cold start** is slow — pre-install `@azure-devops/mcp` in the bridge
  image and spawn the resolved binary, or every session pays multi-second
  launch. Pool / idle-reap for many users.
- **Header choice:** ctxlayer's per-upstream `headerName`/`headerPrefix` let the
  bearer ride a dedicated header (e.g. `X-ADO-Token`) so the bridge's *own*
  ingress auth can keep `Authorization`. Pure config, no code.
- **Security surface:** the bridge holds live tokens in child env — it's the
  gated-execution surface. Front with HTTPS, scope egress, restrict who can
  reach it, never log tokens.

### Curate the skill

Publish `azure-devops.skill.md` (this folder) via admin → Skills and attach it
to the ADO upstream, so agents load the org's conventions (projects, area
paths, read-vs-write etiquette) before calling tools.
