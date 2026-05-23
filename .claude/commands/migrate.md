---
description: Apply pending D1 migrations to local (default) or remote.
argument-hint: [--remote]
---

If `--remote` is passed, run `bun run migrate:remote`; otherwise run
`bun run migrate:local`. Print the migration plan and a concise success or
failure message. Do NOT apply destructive migrations without explicit
confirmation.

Arguments: $ARGUMENTS
