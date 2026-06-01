# @ctxlayer/cli

A small CLI for working with a [ctxlayer](../../README.md) install from your
terminal and from [Claude Code](https://claude.com/claude-code): sign in,
pull your org's published skills into `~/.claude/skills/`, and draft new
skills with your local Claude Code CLI.

## Install

The CLI ships as a single Node binary (`ctxlayer`). From a checkout:

```bash
bun --filter='@ctxlayer/cli' run build   # produces dist/cli.cjs
node packages/cli/dist/cli.cjs --help
```

During development you can run it straight from source with Bun:

```bash
bun --filter='@ctxlayer/cli' run dev -- <command>
```

Requires Node ≥ 20.

## Commands

| Command | What it does |
|---|---|
| `ctxlayer login [--base-url <url>] [--force]` | Sign in to a ctxlayer install via OAuth (Dynamic Client Registration + loopback PKCE). The base URL is remembered after the first login. `--force` re-authenticates even if a valid session exists. |
| `ctxlayer pull [--dry-run]` | Materialise every published skill as a `SKILL.md` under `~/.claude/skills/ctxlayer/`, so Claude Code can load them. `--dry-run` prints the plan without writing. |
| `ctxlayer whoami` | Print the current session: base URL, OAuth client, token expiry. |
| `ctxlayer logout` | Remove the local credentials file. |
| `ctxlayer draft-skill <upstream> [--tool <name>] [--prompt <text>] [--no-save]` | Draft a new skill: fetch the org context for an upstream from ctxlayer, shell out to your local `claude -p`, and post the result back as a `status=draft` skill. `--no-save` renders locally without posting. |

## Authentication

`login` performs a standard RFC 8252 loopback OAuth flow: it registers a public
client (DCR), opens your browser to the install's authorization endpoint, and
exchanges the code with PKCE (S256) over a short-lived `127.0.0.1` listener.

Credentials are stored as `credentials.json`, locked to `0600`, in your
per-OS config dir:

- macOS / Linux: `$XDG_CONFIG_HOME/ctxlayer/` (default `~/.config/ctxlayer/`)
- Windows: `%APPDATA%\ctxlayer\`

Tokens are refreshed automatically; a corrupt or expired credentials file
degrades to a re-login prompt.

## Environment

- `CTXLAYER_DEBUG=1` — print full stack traces on error (normal output stays
  clean otherwise).

## License

MIT — see the root [LICENSE](../../LICENSE).
