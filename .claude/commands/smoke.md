---
description: Deploy a versioned preview, hit smoke endpoints, print a status table.
---

Run a full smoke pass and report back as a compact text table — no
screenshots, mobile-friendly.

Steps:
1. `bun run build` — abort and report if this fails.
2. `bun --filter='@ctxlayer/worker' run deploy:preview` — capture the preview URL.
3. `bun scripts/smoke.mjs <preview-url>` — runs the checks defined in
   `scripts/smoke.mjs`:
   - `GET /api/health`
   - `GET /api/version`
   - `GET /api/config`
   - `GET /api/me` (expects 401 anon; set `SMOKE_ME_OK=1` for sessioned CI)
   - `GET /.well-known/oauth-authorization-server`
   - `POST /mcp` initialize JSON-RPC frame
   - `GET /sign-in` (SPA fallback)
4. The script prints one row per check: ✓/✗ name status ms.
5. If anything fails, surface the response body in a code fence.
