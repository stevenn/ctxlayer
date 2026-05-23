---
description: Deploy a versioned preview, hit smoke endpoints, print a status table.
---

Run a full smoke pass and report back as a compact text table — no
screenshots, mobile-friendly.

Steps:
1. `pnpm build` — abort and report if this fails.
2. `pnpm -F worker deploy:preview` — capture the preview URL.
3. `node scripts/smoke.mjs <preview-url>` — runs:
   - `GET /api/health`
   - `GET /api/version`
   - `GET /.well-known/oauth-authorization-server`
   - `POST /mcp` with an `initialize` JSON-RPC frame
4. Print one row per check: ✓/✗ name latency_ms note.
5. If anything fails, surface the response body in a code fence.
