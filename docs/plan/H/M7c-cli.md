# M7c — CLI design (@ctxlayer/cli on npm)

> Implementation spec for the new `packages/cli/` workspace.
> Depends on M7a's `/api/skills/export` endpoint.
> Status: design, not yet implemented.

## Scope

- New `packages/cli/` workspace, published as `@ctxlayer/cli` on npm.
- `ctxlayer login` — DCR-registered first-party OAuth client +
  loopback PKCE.
- `ctxlayer pull` — fetches published skills from
  `/api/skills/export`, materialises them under `~/.claude/skills/ctxlayer/...`.
- `ctxlayer whoami` — read current token + identity (cheap diagnostic).
- `ctxlayer logout` — delete credentials file.
- Per-OS path resolution (`os.homedir()`, never hardcoded `~`).
- File-based credential storage (`0600` on mac/linux, ACLs on Windows).

Out of scope (deferred):
- `ctxlayer watch` — polled / SSE re-pull on change. Add when a real
  user asks.
- `ctxlayer draft-skill` — M8 deliverable.
- Single-binary distribution (`bun build --compile`) — deferred per H.

## Runtime + build target

| Concern | Choice |
|---|---|
| Source language | TypeScript |
| Build tool | `tsup` (bun-friendly, outputs Node-compatible CJS + ESM) — alternative: hand-rolled `bun build` script |
| Runtime target | **Node 20+** (LTS). Users running `npx @ctxlayer/cli` may or may not have Bun; Node is the lowest common denominator. Tested also under Bun. |
| Module format | CJS for the bin entry (broadest npm compat for `bin` field); internal ESM source |
| Bundling | Yes — single `dist/cli.cjs` file (all deps inlined except `bin`-pinned ones). Keeps install footprint small and startup fast. |
| Dependencies | `commander` (CLI parser, ~12 KB), `zod` (already in shared), `picocolors` (terminal colours, ~5 KB). No native deps. |
| Shebang | `#!/usr/bin/env node` (works under Bun too via Node compat). |

## Workspace setup

### `packages/cli/package.json`

```json
{
  "name": "@ctxlayer/cli",
  "version": "0.1.0",
  "description": "ctxlayer CLI — pull org skills into Claude Code, etc.",
  "license": "UNLICENSED",
  "type": "module",
  "bin": {
    "ctxlayer": "./dist/cli.cjs"
  },
  "files": ["dist/", "README.md"],
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsup src/cli.ts --format cjs --target node20 --bundle --clean",
    "dev": "tsup src/cli.ts --format cjs --target node20 --bundle --watch",
    "typecheck": "tsc --noEmit",
    "lint": "echo 'no lint configured for cli'",
    "test": "vitest run"
  },
  "dependencies": {
    "@ctxlayer/shared": "workspace:*",
    "commander": "^12.1.0",
    "zod": "^3.23.0",
    "picocolors": "^1.0.1"
  },
  "devDependencies": {
    "tsup": "^8.0.0",
    "typescript": "^5.0.0",
    "vitest": "^1.0.0",
    "@types/node": "^20.0.0"
  }
}
```

### `packages/cli/tsconfig.json`

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "paths": {
      "@ctxlayer/shared": ["../shared/src"],
      "@ctxlayer/shared/*": ["../shared/src/*"]
    }
  },
  "include": ["src"]
}
```

### Root `package.json` — no change needed

Workspaces glob is already `["apps/*", "packages/*"]`; `packages/cli/`
gets picked up automatically.

## Source layout

```
packages/cli/
├── package.json
├── tsconfig.json
├── README.md                    (short — usage examples)
└── src/
    ├── cli.ts                   (entry; commander setup + command dispatch)
    ├── commands/
    │   ├── login.ts
    │   ├── pull.ts
    │   ├── whoami.ts
    │   └── logout.ts
    ├── auth/
    │   ├── dcr.ts               (POST /oauth/register on first login)
    │   ├── pkce.ts              (PKCE verifier + challenge helpers)
    │   ├── loopback.ts          (http server for redirect URI)
    │   ├── token-store.ts       (read/write credentials.json with chmod 600)
    │   ├── refresh.ts           (auto-refresh access_token via refresh_token)
    │   └── client.ts            (typed-fetch wrapper that auto-refreshes 401s)
    ├── paths.ts                 (per-OS resolution: skills dir, config dir)
    ├── browser.ts               (openUrl branching on process.platform)
    ├── format.ts                (terminal output helpers; colours, tables)
    └── errors.ts                (typed CLI error class + friendly messages)
```

Files cap at ~150 LoC each per CLAUDE.md convention.

## Per-OS path resolution — `src/paths.ts`

```ts
import { homedir, platform } from 'os';
import { join } from 'path';

// Where the SKILL.md files land. Claude Code reads from these paths.
export function skillsDir(): string {
  // Same path on all OSes: $HOME/.claude/skills/ctxlayer
  // os.homedir() resolves to %USERPROFILE% on Windows, $HOME elsewhere.
  return join(homedir(), '.claude', 'skills', 'ctxlayer');
}

// Where credentials.json lives.
export function configDir(): string {
  if (platform() === 'win32') {
    // Prefer %APPDATA% (roaming) over %LOCALAPPDATA% so creds follow the user
    // across machines if Windows roaming profile is enabled.
    const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'ctxlayer');
  }
  // XDG convention on mac/linux. Honour XDG_CONFIG_HOME if set.
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'ctxlayer');
}

export function credentialsFile(): string {
  return join(configDir(), 'credentials.json');
}
```

No hardcoded `~` anywhere. Tilde-expansion is a shell feature, not
something `fs.*` understands.

## Credential storage — `src/auth/token-store.ts`

```ts
type StoredCredentials = {
  baseUrl: string;                    // ctxlayer install URL
  clientId: string;                   // from DCR
  accessToken: string;
  refreshToken: string;
  expiresAt: number;                  // epoch seconds
  userId?: string;                    // populated on first whoami
  userEmail?: string;
};

export async function loadCredentials(): Promise<StoredCredentials | null> {
  try {
    const raw = await fs.readFile(credentialsFile(), 'utf-8');
    return StoredCredentialsSchema.parse(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function saveCredentials(creds: StoredCredentials): Promise<void> {
  await fs.mkdir(configDir(), { recursive: true });
  await fs.writeFile(credentialsFile(), JSON.stringify(creds, null, 2) + '\n', 'utf-8');
  if (process.platform !== 'win32') {
    // Best-effort chmod. On Windows the file lives under %APPDATA% which
    // is already user-profile-scoped; chmod is a no-op anyway.
    await fs.chmod(credentialsFile(), 0o600);
  }
}

export async function deleteCredentials(): Promise<void> {
  await fs.rm(credentialsFile(), { force: true });
}
```

`StoredCredentialsSchema` is a Zod schema; parse failure → CLI treats
the file as corrupt and prompts re-login.

## `ctxlayer login`

Flow:

1. Parse `--base-url=<url>` flag (or env `CTXLAYER_BASE_URL`); persist
   to credentials so subsequent commands don't need it.
2. Check if already logged in (loadCredentials → valid token → exit 0
   with "already logged in as X. Use `ctxlayer logout` first.").
3. **Discover OAuth metadata**: `GET <baseUrl>/.well-known/oauth-authorization-server`.
4. **Dynamic Client Registration** (`POST /oauth/register`):
   ```json
   {
     "client_name": "ctxlayer CLI",
     "redirect_uris": ["http://127.0.0.1:0/cb"],     // 0 = TBD; rewritten before authorize
     "grant_types": ["authorization_code", "refresh_token"],
     "response_types": ["code"],
     "token_endpoint_auth_method": "none",            // public client, PKCE
     "scope": "mcp"
   }
   ```
   Response: `{ client_id, ... }`. Store `client_id` in credentials.
5. **Loopback server**: spin up an `http.createServer` listener on an
   ephemeral port (`server.listen(0)`); read assigned port via
   `server.address().port`. Redirect URI = `http://127.0.0.1:<port>/cb`.
   **Re-register the client with the actual redirect URI** (DCR allows
   PATCH; alternative is to register exact `http://127.0.0.1/cb` and
   use that — RFC 8252 §7.3 says servers SHOULD allow any port; check
   the worker's OAuth provider on this).
6. **PKCE**:
   ```ts
   const verifier = base64UrlEncode(crypto.randomBytes(32));
   const challenge = base64UrlEncode(crypto.createHash('sha256').update(verifier).digest());
   ```
7. **Open browser**: `openUrl(`<baseUrl>/oauth/authorize?` +
   `response_type=code&client_id=${clientId}&` +
   `redirect_uri=${encoded}&code_challenge=${challenge}&` +
   `code_challenge_method=S256&state=${state}&scope=mcp`)`.
8. **Wait for callback**: loopback server receives `GET /cb?code=…&state=…`.
   Validate state. Respond with a friendly HTML page ("Login complete.
   You may close this tab.").
9. **Exchange code**: `POST <baseUrl>/oauth/token` with
   `grant_type=authorization_code&code=…&code_verifier=…&client_id=…&redirect_uri=…`.
10. **Persist**: `saveCredentials({ baseUrl, clientId, accessToken,
    refreshToken, expiresAt: now + expires_in })`.
11. **whoami self-check**: `GET /api/me` with the token; show
    `Logged in as <email>`.

### Browser opener — `src/browser.ts`

```ts
import { exec } from 'child_process';

export function openUrl(url: string): void {
  const cmd =
    process.platform === 'darwin' ? `open "${url}"` :
    process.platform === 'win32'  ? `start "" "${url}"` :
    `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) {
      console.error(`Could not auto-open the browser. Visit this URL manually:\n  ${url}`);
    }
  });
}
```

Note: never spawn shell with user-controlled input — `url` here is
constructed entirely from PKCE + DCR output, no operator input.

### Loopback server — `src/auth/loopback.ts`

```ts
export function listen(port: 0): Promise<{ port: number; waitForCode: () => Promise<{code: string; state: string}>; close: () => void }> {
  // Creates http server listening on 0 (ephemeral port).
  // Returns the assigned port + a Promise that resolves on /cb hit.
  // Closes itself after the callback or 5-minute timeout.
  // Responds with a small HTML "Login complete. You may close this tab." page.
}
```

Timeout: 5 minutes. If the user never completes, the CLI errors with
"login timed out — try again".

## `ctxlayer pull`

Flow:

1. `loadCredentials()` → bail with `please run "ctxlayer login" first`
   if missing.
2. `refreshIfExpired()` — auto-refresh access token if `expiresAt < now`.
3. `client.get('/api/skills/export')` → returns
   `{ slug, name, description, body_md }[]`.
4. Ensure `skillsDir()` exists (`fs.mkdir(recursive: true)`).
5. For each skill:
   ```
   const dir = join(skillsDir(), skill.slug);
   await fs.mkdir(dir, { recursive: true });
   const content =
     `---\n` +
     `name: ${skill.slug}\n` +                                  // SKILL.md identifier = ctxlayer slug
     `description: ${quoteForYaml(skill.description)}\n` +
     `---\n` +
     `<!-- Managed by @ctxlayer/cli. Edits will be overwritten on next pull. -->\n` +
     `${skill.body_md}`;
   await fs.writeFile(join(dir, 'SKILL.md'), content.replace(/\r\n/g, '\n'), 'utf-8');
   ```
6. **Prune skills no longer in the export**: scan `skillsDir()`, find
   subdirs whose name isn't in the export's slug set, delete them.
   This means non-published / soft-deleted skills disappear locally on
   next pull. Predictable.
7. Print summary: `Pulled N skills (M added, K updated, J pruned).`

**Line endings**: forced LF regardless of platform — Claude Code
expects LF; Git on Windows otherwise smears CRLF on subsequent
operations.

**Managed-by header**: a comment line warns operators not to edit
locally. Not enforced (would require checksum tracking); a hint, not a
lock.

### Token refresh — `src/auth/refresh.ts`

```ts
export async function refreshIfExpired(creds: StoredCredentials): Promise<StoredCredentials> {
  // Refresh if expires within 60s (refresh buffer).
  if (creds.expiresAt > Math.floor(Date.now() / 1000) + 60) return creds;
  const res = await fetch(`${creds.baseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: creds.refreshToken,
      client_id: creds.clientId,
    }),
  });
  if (!res.ok) {
    // Refresh failure → wipe credentials and prompt re-login. Don't log the body.
    await deleteCredentials();
    throw new CtxlayerError(`Session expired. Please run "ctxlayer login" again.`);
  }
  const body = await res.json();
  const updated: StoredCredentials = {
    ...creds,
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? creds.refreshToken,
    expiresAt: Math.floor(Date.now() / 1000) + body.expires_in,
  };
  await saveCredentials(updated);
  return updated;
}
```

`fetch` is global on Node 20+; no `node-fetch` dependency.

## `ctxlayer whoami`

```
loadCredentials → refreshIfExpired → GET /api/me → print:
  Email:    user@example.com
  Role:     admin
  Base URL: https://ctxlayer.acme.com
  Token:    expires in 47 min
```

Useful for "is my CLI talking to the right install".

## `ctxlayer logout`

```
loadCredentials → if none, "not logged in" exit 0
else → confirm via stdin prompt unless --force → deleteCredentials → "logged out"
```

Doesn't revoke server-side. (M-future: call `POST /oauth/revoke` if the
worker grows one.)

## CLI UX — `src/format.ts`

Use `picocolors` for terminal colours (no chalk, smaller). Print:

- Errors: `pc.red('error:')` prefix
- Success: `pc.green('✓')` prefix
- Info: no colour
- Tables: hand-rolled padded columns (avoid `cli-table3` for size)

Spinners: **none** (per [[feedback-terse-mobile]] — Steven runs from
web/mobile; spinners look bad). Just print "Fetching skills…" and
then the result.

## File inventory

### New files

```
packages/cli/
├── package.json
├── tsconfig.json
├── README.md                    (~80 lines: install, login, pull examples)
└── src/
    ├── cli.ts
    ├── commands/login.ts
    ├── commands/pull.ts
    ├── commands/whoami.ts
    ├── commands/logout.ts
    ├── auth/dcr.ts
    ├── auth/pkce.ts
    ├── auth/loopback.ts
    ├── auth/token-store.ts
    ├── auth/refresh.ts
    ├── auth/client.ts
    ├── paths.ts
    ├── browser.ts
    ├── format.ts
    └── errors.ts
```

### Modified files — minimal

```
.gitignore                       — add packages/cli/dist
README.md                        — short CLI section pointing at npm
```

## Worker-side: anything to add for M7c?

Mostly no — `/api/skills/export` is M7a; DCR + OAuth endpoints
already exist. **One thing to confirm during impl**: does the
existing OAuth provider config accept a `redirect_uri` with a
dynamic ephemeral port?

- Per `apps/worker/src/oauth/provider-config.ts:1-40` and the
  `@cloudflare/workers-oauth-provider` library, DCR-registered clients
  declare their `redirect_uris` at registration time. If the worker's
  provider does exact-match validation (no port wildcarding), the CLI
  must either:
  - Re-register on every login (cheap, but pollutes the OAuth-clients
    list with one row per login session), OR
  - Register once with `http://127.0.0.1:0/cb` and patch on first
    actual login (depends on PATCH support), OR
  - Register with `http://127.0.0.1/cb` (no port) and accept that
    some OAuth providers normalise this — RFC 8252 §7.3 recommends
    servers allow any port for loopback URIs, but `workers-oauth-provider`'s
    behaviour needs verification.

**Resolution**: dig into `@cloudflare/workers-oauth-provider`'s
loopback handling during M7c impl. If it doesn't honour
RFC 8252 §7.3 (any port for `127.0.0.1`), file a small worker-side
patch to special-case loopback redirects in DCR. Likely a one-line
PR upstream. Mark as **risk + spike during impl**.

## Verification

1. **Build artifact sanity**: `bun --filter='@ctxlayer/cli' run build`
   → `dist/cli.cjs` exists, ~200KB. `node dist/cli.cjs --version`
   prints version. `node dist/cli.cjs --help` lists commands.
2. **Local sanity** without publishing: `npm link` from packages/cli
   → `ctxlayer --help` works from any cwd.
3. **Login E2E (against deployed worker)**:
   - `ctxlayer login --base-url=https://ctxlayer.stevenn-a65.workers.dev`
   - Browser opens IdP chooser → GitHub flow completes → "Login
     complete" page renders in browser → CLI prints "Logged in as
     stevenn@satisa.be".
   - `cat ~/.config/ctxlayer/credentials.json` → JSON with
     access_token, refresh_token, expires_at; `stat -c %a` shows
     `600` on linux/mac.
4. **Pull E2E**:
   - Create + publish a skill via SPA (`linear-triage`).
   - `ctxlayer pull` → prints "Pulled 1 skill (1 added)".
   - `cat ~/.claude/skills/ctxlayer/linear-triage/SKILL.md` shows
     valid frontmatter + body + managed-by comment.
   - Open Claude Code in a fresh dir → ask the agent for help with a
     triage task → it consults the skill (Claude Code reflects skill
     usage in its output).
5. **Refresh token loop**: wait for `expiresAt < now`, run
   `ctxlayer whoami` → it auto-refreshes silently. Inspect
   credentials.json → `accessToken` differs from before.
6. **Pruning**: soft-delete (or un-publish) a skill server-side → run
   `ctxlayer pull` → local dir disappears.
7. **Windows path resolution**: spin up a Windows VM (or
   `windows-latest` CI), `npm i -g @ctxlayer/cli`, `ctxlayer pull` →
   SKILL.md lands under `C:\Users\<user>\.claude\skills\ctxlayer\...`
   with LF line endings (`file` reports "ASCII text" not "ASCII text,
   with CRLF").
8. **`bun run typecheck`** — clean across all workspaces including
   the new CLI.

## Publishing to npm (M7c release)

Out of scope for the first M7c PR — local `npm link` for early
testing is enough. Once the worker pieces and SPA author flow are
solid:

1. Reserve the npm scope `@ctxlayer` (one-time).
2. CI workflow on `release/cli-v*` tag: `bun --filter='@ctxlayer/cli'
   run build` → `npm publish --access=public` with NPM_TOKEN secret.
3. Tag scheme: `cli-v0.1.0` (so other workspace tags don't collide).

## Risks called out

- **Loopback port matching in `@cloudflare/workers-oauth-provider`**
  — see "Worker-side" section. Spike on day 1 of M7c impl.
- **Bundling Zod**: Zod ships as ESM-mainly; `tsup` should handle the
  CJS conversion fine, but verify the built `dist/cli.cjs` runs under
  plain Node 20 (no `--experimental-vm-modules`).
- **`open`/`xdg-open`/`start` on uncommon Linux desktops**: if
  `xdg-open` is missing (rare but happens on headless boxes), fall
  through gracefully by printing the URL and asking the operator to
  open manually. Don't fail the command.
- **Token leakage in error messages**: the auto-refresh failure path
  must not log the failed response body (per CLAUDE.md security
  notes). Already in the design — flag during code review.
- **`npm i -g` permission issues** on systems where `npm`'s global
  prefix isn't user-writable. Document `npx @ctxlayer/cli ...` as the
  zero-friction path in the README.

## Sequencing within M7c

1. **Workspace bootstrap** — package.json, tsconfig, empty `cli.ts`
   with `commander` set up + `--help` stub. Confirms the build chain.
2. **`logout` + `whoami`** — simplest commands; exercise token-store
   + client wiring against an already-existing credentials file
   (manually authored for the test).
3. **`login`** — biggest piece; loopback server + PKCE + DCR.
   Worker-side loopback-port spike happens here. End in "I can login
   against the deployed worker".
4. **`pull`** — once `client.get` works with auto-refresh and
   `/api/skills/export` exists from M7a, pull is mostly
   FS plumbing.
5. **Windows verify** — defer to the `windows-latest` CI smoke job.
   Don't block M7c release on it; first user on Windows confirms or
   files an issue.

Each step is independently committable; cli is buildable and
`--version` works from step 1.
