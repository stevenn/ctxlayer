# Auth flows (inbound + outbound)

ctxlayer is **two-sided**: an OAuth **issuer** to MCP clients and SPA users, and an OAuth **client** to upstream services. Each side has multiple sub-flows. Below are the full sequences.

### A1. Inbound — MCP client connects (DCR flow, preferred)

Used when the MCP client supports Dynamic Client Registration (Claude Desktop, Claude Web, Cursor, Windsurf, mcp-remote).

```
MCP client                      ctxlayer (Worker)                Google/GitHub
    |                                |                                |
    | 1. GET /.well-known/           |                                |
    |    oauth-authorization-server  |                                |
    |------------------------------->|                                |
    |<---- metadata (RFC 8414) ------|                                |
    | 2. POST /oauth/register (RFC 7591)                              |
    |    {redirect_uris, ...}        |                                |
    |------------------------------->|                                |
    |<---- {client_id, ...} ---------|                                |
    | 3. GET /oauth/authorize?response_type=code&code_challenge=...    |
    |------------------------------->|                                |
    |       (no session cookie)      | --shows IdP chooser SSR page-->|
    |<---- 200 chooser page ---------|                                |
    | 4. user clicks "Sign in with Google"                            |
    |    GET /idp/google/start?state=<authz_state>                    |
    |------------------------------->|                                |
    |                                | 302 to Google authorize        |
    |<---- 302 ----------------------|                                |
    | 5. Google login + consent      |                                |
    |------------------------------->|------------------------------->|
    |                                |<--- 302 /idp/google/callback   |
    | 6. /idp/google/callback?code=  |                                |
    |------------------------------->|                                |
    |                                | exchange code, verify id_token,|
    |                                | check hd == ALLOWED_GOOGLE_HD, |
    |                                | upsert user in D1,             |
    |                                | call provider.completeAuthor-  |
    |                                |   ization(props={userId,email, |
    |                                |   role,scopes})                |
    |<---- 302 redirect_uri+code ----|                                |
    | 7. POST /oauth/token?grant=    |                                |
    |    authorization_code+verifier |                                |
    |------------------------------->|                                |
    |<---- {access_token,            |                                |
    |       refresh_token,           |                                |
    |       aud: "https://.../mcp"}--|                                |
    | 8. POST /mcp (Authorization: Bearer <access_token>)             |
    |------------------------------->|                                |
    |                                | OAuthProvider middleware       |
    |                                | -> decodes token, attaches     |
    |                                |    props to ctx.executionCtx   |
    |                                | -> routes to McpSessionDO      |
    |                                |    (DO id derived from         |
    |                                |    Mcp-Session-Id header)      |
    |<---- JSON-RPC initialize ack --|                                |
```

Key implementation notes:
- `@cloudflare/workers-oauth-provider` exposes `provider.fetch(req, env, ctx)`. Mount it as the **outermost** handler in `index.ts`. It intercepts `/.well-known/oauth-authorization-server`, `/oauth/register`, `/oauth/authorize`, `/oauth/token`, `/oauth/revoke` automatically. Everything else falls through to `defaultHandler`.
- The IdP leg is **inside** `defaultHandler` because it's UI flow. After the IdP callback verifies + upserts the user, it calls `provider.completeAuthorization({ request, userId, metadata, scope, props })`. That issues the authorization code that the MCP client redeemed in step 7.
- `props` is **end-to-end encrypted** by the provider library before being stored against the token in KV. The encryption uses a key derived from `OAUTH_KV` so only the live Worker can decrypt — a KV dump alone does not leak `props`.
- The `aud` claim on the issued access token is set to `${PUBLIC_BASE_URL}/mcp` (RFC 8707). The Worker validates `aud` on every request — a token leaked from another aud is rejected.

### A2. Inbound — MCP client without DCR (paste-bearer fallback)

Some clients still don't speak DCR. Provide a fallback:
- The user signs into the SPA, navigates to `/app/mcp-setup`, clicks "Generate access token".
- Worker creates a long-lived OAuth client (DCR-equivalent) bound to this user with a fixed redirect, then issues a refresh-friendly access token using the same `props` payload.
- Page displays the token + the MCP server URL + a copy-pasteable JSON snippet for the user's `claude_desktop_config.json` / Cursor settings.
- These tokens are listed in admin "OAuth clients" UI and can be revoked.

### A3. Inbound — SPA session cookie (separate from MCP tokens)

The SPA needs its own session — it doesn't hold an MCP OAuth token; that's for MCP clients only.
- The same `/idp/google/start` and `/idp/github/start` endpoints accept a query flag `?ui=1` indicating SPA login.
- After the IdP callback succeeds, instead of calling `provider.completeAuthorization`, the handler sets a `__Host-ctx_session` cookie:
  - `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, `Max-Age=30d`.
  - Body is `{ userId, role, exp }` signed with `SESSION_COOKIE_SECRET` (HMAC-SHA256) — cheap to verify on every `/api/*` call.
- A second cookie `__Host-ctx_csrf` holds a random token; the SPA echoes it in `X-CSRF` for unsafe methods.
- Sign-out: `/api/auth/signout` clears both cookies. Doesn't affect MCP tokens (separate lifecycles).

### A4. Allowlist enforcement (centralised)

Each IdP has two parallel allowlists; the user passes when EITHER matches:

| IdP | Domain/org allowlist | Per-user allowlist | Both empty |
|---|---|---|---|
| Google | `ALLOWED_GOOGLE_HD` (Workspace `hd` claim) | `ALLOWED_GOOGLE_EMAILS` (comma-separated emails) | IdP disabled |
| GitHub | `ALLOWED_GITHUB_ORG` (org slug, requires `read:org`) | `ALLOWED_GITHUB_USERS` (comma-separated logins) | IdP disabled |

The per-user allowlist is cheap (no API call) and is checked first; the
org/domain check falls through only if the user isn't on it. The per-
user form supports solo developers, founders, demo accounts, and local
dev for contributors who don't want to put their corp org slug into
the committed `wrangler.toml`.

Implementation lives in `apps/worker/src/util/allowlist.ts`:
- `enforceGoogleAllowlist(profile, env)` — sync, checks `hd` ∨ email.
- `enforceGithubAllowlist({accessToken, login, env})` — async, login
  match wins; org membership check is the fallback that costs one
  `GET /user/orgs` request.

Failures throw `AllowlistError(reason)`; callers redirect to
`/sign-in?error=<reason>` with a friendly message. Reasons:
`google_disabled`, `github_disabled`, `wrong_domain`, `not_in_org`.

### A5. Outbound — `user_bearer` flow

```
User in SPA           ctxlayer                 (no upstream interaction during setup)
   |                     |
   | POST /api/upstreams/:id/credentials
   | { kind:'bearer', token:'ghp_xxx' }
   |-------------------->|
   |                     | AES-GCM seal(token), insert user_credentials
   |<-- 204 -------------|

(later, during MCP session)
McpSessionDO           upstream
   |                     |
   | open creds row, AES-GCM open(ciphertext) -> {access_token}
   | Streamable HTTP POST {...} with Authorization: Bearer ghp_xxx
   |-------------------->|
   |<--- tool result ----|
```

### A6. Outbound — `user_oauth` flow

ctxlayer is a confidential OAuth client to the upstream. Upstream's client_id/secret are stored in `upstream_servers.auth_config` (the secret is encrypted with `ENCRYPTION_KEY`).

```
User in SPA              ctxlayer                          Upstream
   | click "Connect Linear" |                                  |
   | GET /api/upstreams/:id/oauth/start?return_to=/upstreams   |
   |------------------------>|                                  |
   |                         | generate state (signed cookie),  |
   |                         | PKCE verifier (KV TTL 10min),    |
   |                         | construct authorize URL          |
   |<-- 302 to upstream --- |                                  |
   | GET upstream/authorize? client_id=..&code_challenge=..&state=..
   |--------------------------------------------------------->|
   | user grants                                              |
   |<-- 302 ctxlayer/api/upstreams/:id/oauth/callback?code=---|
   |                         |                                  |
   | GET /callback?code=&state=                                 |
   |------------------------>|                                  |
   |                         | verify state cookie, fetch       |
   |                         | verifier from KV, POST token EP--|
   |                         |<-- {access_token, refresh_token, |
   |                         |     expires_in} -----------------|
   |                         | AES-GCM seal, upsert user_credentials kind='oauth'
   |<-- 302 return_to -------|

(later, on refresh)
UpstreamClient.ensureFreshToken():
  if now + 60s > expires_at:
    POST upstream/token grant_type=refresh_token refresh_token=...
    AES-GCM seal new pair, UPDATE user_credentials
    (with a per-user mutex via DO single-threaded execution to avoid double-refresh)
```

### A7. Outbound — `shared_bearer`

Admin pastes once in `/app/admin/upstreams` edit form. Stored in `upstream_servers.auth_config` encrypted. Injected unconditionally. No `user_credentials` row exists. Risk: every user appears as the same identity to upstream; rate limits shared.

### A8. Token & secret matrix

| What | Where | Lifetime | Encrypted? |
|---|---|---|---|
| Inbound MCP access token | `OAUTH_KV` (provider-managed) | 1h, refreshable | Yes (provider) |
| Inbound MCP refresh token | `OAUTH_KV` | rolling, max ~90d | Yes (provider) |
| SPA session cookie | client browser | 30d | HMAC-signed, not encrypted (no secrets in body) |
| User upstream `bearer` PAT | `user_credentials` | until user revokes | AES-GCM, `ENCRYPTION_KEY` |
| User upstream OAuth tokens | `user_credentials` | per upstream policy | AES-GCM, `ENCRYPTION_KEY` |
| Admin shared bearer | `upstream_servers.auth_config` | until admin rotates | AES-GCM, `ENCRYPTION_KEY` |
| Upstream OAuth client secret | `upstream_servers.auth_config` | until admin rotates | AES-GCM, `ENCRYPTION_KEY` |
| `ENCRYPTION_KEY`, IdP secrets, `DAYTONA_API_KEY` | wrangler secrets | rotated by ops | yes (CF secret) |

---

