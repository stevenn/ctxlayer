---
description: Load fixture teams + products into the local D1 database.
---

Run `bun run seed:local`. The seed script inserts three teams (Platform, Web,
Data) and two products (Checkout, Search) so the org-IA surfaces — team/product
pickers, visibility grants, doc tags — have something to render. Ids are
deterministic and every insert is `INSERT OR IGNORE`, so it is idempotent.

It does NOT seed upstreams or docs. Docs need a real `created_by` user, and
inserting a fake user row would bypass the IdP allowlist; register an upstream
through `/app/admin/upstreams` and create docs by signing in.

`seed:remote` is a separate command and must be explicit — see
`scripts/seed.mjs`.
