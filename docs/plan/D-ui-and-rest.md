# UI surface + REST endpoints

### D1. Sitemap

```
/                           -> redirect: signed in ? /app/docs : /sign-in
/sign-in                    -> Google + GitHub chooser
/idp/google/start           -> redirect to Google
/idp/google/callback        -> Google OIDC callback
/idp/github/start           -> redirect to GitHub
/idp/github/callback        -> GitHub OAuth callback
/oauth/*                    -> workers-oauth-provider (DCR, authorize, token, revoke)
/mcp                        -> Streamable HTTP MCP endpoint
/sse                        -> SSE MCP endpoint
/collab/:docId              -> WebSocket upgrade for Yjs
/api/*                      -> REST (see D5)

# SPA (Workers Assets) — all client-side routed
/app/docs                   -> doc library list
/app/docs/new
/app/docs/:id               -> BlockNote editor + Yjs
/app/docs/:id/revisions
/app/upstreams              -> connect wizard cards
/app/mcp-setup              -> setup instructions + token generator
/app/usage                  -> personal stats
/app/profile                -> name/email, signout
/app/admin/upstreams        -> CRUD upstreams
/app/admin/users            -> users list + role mgmt
/app/admin/usage            -> dashboards
/app/admin/sandboxes        -> live + archived sandboxes
/app/admin/oauth-clients    -> issued MCP clients
/app/admin/audit            -> audit log tail
/app/admin/docs             -> same as user docs + delete + rename
```

### D2. User screens (wireframes-in-text)

**`/sign-in`**
```
┌────────────────────────────────────────────┐
│              ctxlayer                      │
│   The agent context layer for {ORG}        │
│                                            │
│   [ Sign in with Google     ]              │
│   [ Sign in with GitHub     ]              │
│                                            │
│   Only @acme.com Google accounts and       │
│   @acme-inc GitHub members can sign in.    │
└────────────────────────────────────────────┘
```
On error: subtle banner ("Your account isn't in the allowed org.").

**`/app/docs`** (default landing after sign-in)
```
┌─────────────┬──────────────────────────────────────────────────┐
│ ctxlayer    │  Docs library                       [+ New doc]  │
│             │  ┌────────────────────────────────────────────┐  │
│ Docs        │  │ q search...                                │  │
│ Upstreams   │  └────────────────────────────────────────────┘  │
│ MCP setup   │                                                   │
│ Usage       │  ▸ Engineering ▾                                  │
│             │     • SRE runbooks         updated 3h ago         │
│ Admin       │     • API guidelines       updated yesterday      │
│ • Upstreams │  ▸ Product ▸                                     │
│ • Users     │  ▸ Prompts ▸                                     │
│ • Usage     │                                                   │
│ • Audit     │                                                   │
└─────────────┴──────────────────────────────────────────────────┘
```

**`/app/docs/:id`** — BlockNote editor occupies the canvas; left nav stays. A presence avatar strip in the header shows other connected editors. Top-right: "Revisions" opens a side drawer listing recent `doc_revisions` rows with restore.

**`/app/upstreams`**
```
Connect your tools

┌─ Notion ───────────────────── [HTTP] ─┐  ┌─ Linear ─────────────── [OAuth] ─┐
│ Status: Not connected                  │  │ Status: Connected (expires 5d) │
│ Auth: paste your Notion integration   │  │ [ Reconnect ]  [ Disconnect ]   │
│ token from notion.com/integrations    │  └─────────────────────────────────┘
│ [ ghp_____________________ ] [Save]   │
└────────────────────────────────────────┘
┌─ GitHub (stdio) ────────────── [PAT] ─┐  ┌─ Filesystem ─────────── [Shared]─┐
│ Status: Not connected                  │  │ Configured by admin (read-only) │
│ Sandbox: starts on first use           │  │ Status: Available to everyone   │
│ [ ghp_____________________ ] [Save]   │  └─────────────────────────────────┘
└────────────────────────────────────────┘
```

**`/app/mcp-setup`**
```
Connect ctxlayer to your AI tool

Server URL:  https://ctx.acme.com/mcp                     [Copy]
Auth:        OAuth (preferred) or paste a token

▸ Claude Desktop — preferred (OAuth via DCR)
  1. Open Settings → Developer → Edit Config
  2. Add this server block:
     {
       "mcpServers": {
         "ctxlayer": { "url": "https://ctx.acme.com/mcp" }
       }
     }
  3. Restart Claude Desktop. It will open ctxlayer in your browser to sign in.
  [Copy snippet]

▸ Cursor / Windsurf / others without DCR — paste-bearer fallback
  [Generate token]  -> shows ctx_pat_xxxx (valid 90d)
  Then paste into the client's config under Authorization: Bearer.
```

**`/app/usage`** — three small stat cards (today / 7d / 30d: calls, tokens-in, tokens-out), a line chart of calls/day, a horizontal bar of top tools.

### D3. Admin screens

**`/app/admin/upstreams`** — sortable list, columns: Slug, Name, Transport, Auth strategy, Users connected, Last call. Row click → edit modal:
- Common fields: slug, display_name, transport (`streamable_http`|`sse`|`stdio_daytona`), enabled toggle.
- Conditional fields by transport:
  - `streamable_http`/`sse`: URL.
  - `stdio_daytona`: snapshotId picker (lists snapshots from `infra/daytona-snapshots/`), startCommand, bridgePort (default 8080), envTemplate JSON editor, idleTimeoutSeconds.
- Conditional fields by auth strategy:
  - `shared_bearer`: bearer input (encrypted on save).
  - `user_oauth`: client_id, client_secret, authorize_url, token_url, scopes (space-separated).
- Buttons: "Test connection" (transport check; for stdio, briefly create a no-credential probe sandbox and call `tools/list`), "Refresh tool cache".

**`/app/admin/users`** — table: avatar, email, IdP, role, last seen, 30d calls, connected upstreams count. Row click → drawer with promote/demote, revoke all credentials, force sign-out (deletes their OAuth tokens from `OAUTH_KV`).

**`/app/admin/usage`** — date-range picker, group-by selector (user | upstream | tool), line + stacked bar + top-N tables. Drill-down link from any row to a filtered view. Underlying queries hit `usage_rollups_daily`.

**`/app/admin/sandboxes`** — live table from Daytona API joined with `sandbox_sessions`. Columns: User, Upstream, State (running/idle/archived), Started, Last active, Cost-est. Force-destroy button per row, bulk destroy for an upstream.

**`/app/admin/oauth-clients`** — list of issued OAuth clients (reads `OAUTH_KV`). Columns: client_id, registered, last used, redirect URIs, owner_user_id. Revoke purges tokens for that client.

**`/app/admin/audit`** — virtualised tail of `audit_log`. Filters: actor, action, target. Export-to-CSV.

### D4. Role gating

- Server-side: every `/api/admin/*` route in Hono goes through a `requireAdmin` middleware that re-reads `users.role` from D1 (don't trust the SPA cookie's role alone — refresh on each request).
- Client-side: a `useMe()` hook fetches `/api/me` once per session; admin nav items render only if `role==='admin'`. Cosmetic only.

### D5. REST endpoint catalogue

All under `/api`. JSON in / JSON out. CSRF token required for unsafe methods (`X-CSRF` header).

```
GET    /api/me                              -> { id, email, name, role, idp, lastSeenAt }
POST   /api/auth/signout                    -> 204
GET    /api/docs                            -> [{ id, title, slug, updatedAt, kind }]
POST   /api/docs                            -> { id, slug } (creates empty doc)
GET    /api/docs/:id                        -> { id, title, slug, kind, currentRevId, lastUpdatedBy }
PATCH  /api/docs/:id                        -> { title?, slug?, kind? }  (rename etc.)
DELETE /api/docs/:id                        -> 204 (soft delete)
GET    /api/docs/:id/revisions              -> [{ id, authorId, createdAt, byteSize }]
GET    /api/docs/:id/revisions/:rev         -> markdown text/plain
POST   /api/docs/:id/restore                -> { revisionId } -> 204

GET    /api/upstreams                       -> [{ id, slug, name, transport, authStrategy, enabled, connected }]
                                               (user-shaped; connected reflects calling user's credentials)
POST   /api/upstreams/:id/credentials       -> { kind:'bearer', token }   -> 204
DELETE /api/upstreams/:id/credentials       -> 204
GET    /api/upstreams/:id/oauth/start?return_to=  -> 302
GET    /api/upstreams/:id/oauth/callback    -> 302 to return_to

GET    /api/usage/me?from=&to=&group=       -> [{ key, calls, reqBytes, respBytes, reqTokens, respTokens, errors }]

# admin only
GET    /api/admin/upstreams                 -> full rows (with auth_config sans secrets)
POST   /api/admin/upstreams                 -> { ...full body } -> { id }
PATCH  /api/admin/upstreams/:id             -> partial -> 204
DELETE /api/admin/upstreams/:id             -> 204
POST   /api/admin/upstreams/:id/test        -> { ok, latencyMs, toolsCount } | { ok:false, error }
POST   /api/admin/upstreams/:id/refresh     -> { toolsCount } (re-cache catalogue)

GET    /api/admin/users                     -> rows + denormalised stats
POST   /api/admin/users/:id/role            -> { role:'admin'|'user' } -> 204
POST   /api/admin/users/:id/credentials/revoke_all -> 204
POST   /api/admin/users/:id/sessions/revoke -> 204

GET    /api/admin/usage?...                 -> series + tables
GET    /api/admin/sandboxes                 -> live joined view
DELETE /api/admin/sandboxes/:sandboxId      -> 204 (force destroy via Daytona)

GET    /api/admin/oauth-clients             -> rows from OAUTH_KV
POST   /api/admin/oauth-clients/:id/revoke  -> 204
GET    /api/admin/audit?from=&to=&actor=    -> rows

GET    /api/health                          -> { ok, dependencies:[{name, ok, latencyMs}] }
GET    /api/version                         -> { gitSha, builtAt }
```

`packages/shared/src/api-types.ts` defines a Zod schema for every endpoint body; both the Hono route and the React fetch helper import the same types. End-to-end type safety without an RPC framework.

---

