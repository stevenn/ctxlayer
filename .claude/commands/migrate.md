---
description: Apply pending D1 migrations to local (default) or remote.
argument-hint: [--remote]
---

If `--remote` is passed, run `pnpm migrate:remote`; otherwise run
`pnpm migrate:local`. Print the migration plan and a concise success or
failure message. Do NOT apply destructive migrations without explicit
confirmation.

Arguments: $ARGUMENTS
