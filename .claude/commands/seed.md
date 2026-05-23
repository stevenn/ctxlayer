---
description: Load fixture upstreams + docs into the local D1 database.
---

Run `pnpm seed:local`. The seed script inserts a Notion HTTP upstream, a
GitHub-stdio Daytona upstream (disabled by default), and three demo docs so
the SPA and MCP server have something to render. Idempotent; safe to re-run.
