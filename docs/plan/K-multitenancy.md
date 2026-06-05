# K — Multi-tenancy (tenant.ctxlayer.net)

> **STATUS: exploratory plan — NOT implemented.** ctxlayer today is
> single-org per deployment ("each install serves one org"). This doc
> captures the chosen direction for hosting many orgs as
> `tenant.ctxlayer.net`, and the per-tenant provisioning automation it
> implies. Nothing here is built yet.

## Verdict

Feasible. Two independent layers:

- **Cloudflare routing/TLS** — easy. A dedicated `ctxlayer.net` zone makes
  `*.ctxlayer.net` free under Universal SSL (no ACM), and per-tenant
  `custom_domain = true` auto-provisions each host's DNS + cert.
- **App isolation** — ctxlayer is single-org by design (zero `tenant_id`
  columns; one D1 / Vectorize×2 / R2 / KV / DO×2 / queues×3; single
  `PUBLIC_BASE_URL` / IdP app / `ENCRYPTION_KEY` / `SESSION_COOKIE_SECRET`
  / `ADMIN_EMAILS`).

Because the app is single-org, **scenario B — one deployment per tenant —
needs ZERO app-code changes.** It is pure ops: provisioning automation +
a tenant registry. (Scenario A, a shared worker with row-level
`tenant_id` on ~25 tables, is a large, security-critical rewrite and is
NOT chosen.)

Two facts already favour subdomains: `__Host-` session cookies are
host-bound (per-tenant session isolation is automatic), and the MCP OAuth
issuer is derived per-request host (per-tenant
`/.well-known/oauth-authorization-server` "just works").

## Why `tenant.ctxlayer.net` over `tenant.ctxlayer.satisa.be`

| | `tenant.ctxlayer.satisa.be` | `tenant.ctxlayer.net` (chosen) |
|---|---|---|
| `tenant` is | a 2-level label under `satisa.be` | a direct subdomain of `ctxlayer.net` |
| Universal SSL | covers `*.satisa.be` only → **not** `*.ctxlayer.satisa.be` | covers `*.ctxlayer.net` → **free** |
| Cert cost | **ACM ~$10/mo** required | free (or per-host via `custom_domain`) |

A dedicated apex also decouples product DNS from `satisa.be`, gives
cleaner tenant URLs, keeps the option of a `.ctxlayer.net`-scoped SSO
cookie, and eases future tenant-owned custom hostnames (Cloudflare for
SaaS). The only new cost is registering + managing the `ctxlayer.net`
zone (~$10-15/yr). Requires a **full** zone (nameservers delegated to
Cloudflare) for the wildcard cert.

## B vs. Workers for Platforms (WfP)

Both deliver B's isolation. Difference is routing + scale management:

- **N discrete deployments** (this plan): a `custom_domain` route per
  tenant, ceiling is the per-account Worker-script limit (hundreds).
  Simplest; no add-on; no DO/queue-in-dispatch-namespace caveats.
- **WfP**: one dispatcher Worker on `*.ctxlayer.net` routes by Host to
  per-tenant user Workers in a dispatch namespace; scales to thousands;
  paid add-on; verify current DO/queue/cron support inside dispatch
  namespaces before committing.

Start with N discrete deployments; graduate to WfP only when route /
script-count / secret sprawl hurts. Either way, **per-tenant resource
provisioning is the same** — WfP solves routing + script count, not
provisioning.

## Plan (phased)

| Phase | What | Cadence |
|---|---|---|
| **0 · Platform setup** | Register `ctxlayer.net`, add zone to the CF account, write `wrangler.template.toml`, pick IdP strategy + secret store + tenant registry | once |
| **1 · Provision** | Per tenant: create stores → render config → migrate → set secrets → deploy (`custom_domain` auto-provisions DNS+TLS) → verify | per tenant |
| **2 · Bootstrap** | First admin via `ADMIN_EMAILS`; smoke `/api/health` + sign-in + MCP `whoami` | per tenant |
| **3 · Lifecycle** | Release = build once → fan-out **migrate + deploy** over the registry; deprovision script | ongoing |
| **4 · Graduate** | Move to WfP / consolidate shared-able stores when per-account limits bite | at scale |

## Decisions to make first (the non-mechanical bits)

1. **IdP** — per-tenant GitHub **OAuth App** (manual create; callback
   `https://<slug>.ctxlayer.net/idp/github/callback`) for low N, **or** a
   central `auth.ctxlayer.net` (one app, bounces back to the tenant) for
   scale. This is the only step that isn't fully scriptable (GitHub has
   no API to create classic OAuth Apps).
2. **Secret custody** — the script generates `ENCRYPTION_KEY` /
   `SESSION_COOKIE_SECRET` per tenant; **store them securely**. Losing a
   tenant's `ENCRYPTION_KEY` makes its sealed upstream credentials
   unrecoverable. Never commit them.
3. **Tenant registry** — a private `tenants.json` (or a control-plane D1)
   mapping `slug → {d1_id, kv_id, host}`. Drives all fan-out.

## `scripts/provision-tenant.sh`

```bash
#!/usr/bin/env bash
# Stand up one ctxlayer tenant (scenario B). Run from repo root, wrangler
# logged into the CF account that owns the ctxlayer.net zone.
# Usage: GITHUB_CLIENT_ID=… GITHUB_CLIENT_SECRET=… ./provision-tenant.sh acme admin@acme.com
set -euo pipefail
SLUG="${1:?slug}"; ADMIN_EMAIL="${2:?admin email}"
WORKER="ctxlayer-${SLUG}"; HOST="${SLUG}.ctxlayer.net"; BASE="https://${HOST}"
CFG="wrangler.${SLUG}.toml"
echo "▶ ${SLUG} → ${BASE}"

# 1 · stateful resources (deterministic names from the slug) -------------
D1_ID=$(wrangler d1 create "$WORKER" --json | jq -r '.uuid // .database_id')
KV_ID=$(wrangler kv namespace create "OAUTH_KV_${SLUG}" --json | jq -r '.id')
wrangler r2 bucket create   "${WORKER}-docs"
wrangler vectorize create   "${WORKER}-docs"         --dimensions 768  --metric cosine
wrangler vectorize create   "${WORKER}-docs-lexical" --dimensions 1536 --metric cosine
for q in usage reindex git-sync; do wrangler queues create "${WORKER}-${q}"; done

# 2 · render per-tenant config (bindings are structural → can't be --var) -
export SLUG WORKER HOST D1_ID KV_ID
envsubst < wrangler.template.toml > "$CFG"

# 3 · schema on the fresh D1 ---------------------------------------------
wrangler d1 migrations apply "$WORKER" --remote -c "$CFG"

# 4 · per-tenant secrets (piped → never hit argv/shell history) ----------
gen(){ openssl rand -hex 32; }
gen                            | wrangler secret put ENCRYPTION_KEY        --name "$WORKER"
gen                            | wrangler secret put SESSION_COOKIE_SECRET --name "$WORKER"
printf '%s' "$ADMIN_EMAIL"     | wrangler secret put ADMIN_EMAILS          --name "$WORKER"
printf '%s' "${GITHUB_CLIENT_ID:?}"     | wrangler secret put GITHUB_CLIENT_ID     --name "$WORKER"
printf '%s' "${GITHUB_CLIENT_SECRET:?}" | wrangler secret put GITHUB_CLIENT_SECRET --name "$WORKER"
#   ⚠ capture the two generated values into your secret store now.

# 5 · build SPA once + deploy (runtime config via --var) -----------------
bun run build:web
wrangler deploy -c "$CFG" \
  --var PUBLIC_BASE_URL:"$BASE" \
  --var GIT_SHA:"$(git rev-parse --short HEAD)" \
  --var ALLOWED_GITHUB_ORG:"${ALLOWED_GITHUB_ORG:-}"

# 6 · verify + register -------------------------------------------------
sleep 3; curl -fsS "${BASE}/api/health" | jq '{version,ok}'
jq --arg s "$SLUG" --arg d "$D1_ID" --arg k "$KV_ID" --arg h "$HOST" \
   '.[$s]={d1:$d,kv:$k,host:$h}' tenants.json > t && mv t tenants.json
echo "✅ ${BASE} live — manual: add OAuth callback ${BASE}/idp/github/callback"
```

## `wrangler.template.toml`

Same bindings as the base `wrangler.toml`, slug-parameterized + a route.
Key `.net` simplification: `custom_domain = true` auto-creates the DNS
record and a free per-host cert — no wildcard DNS, no ACM. Durable
Objects come free per deployment (each worker script gets its own DO
namespace), so there is no per-tenant DO step.

```toml
name = "${WORKER}"
main = "apps/worker/src/index.ts"
compatibility_date = "2026-04-01"
compatibility_flags = ["nodejs_compat", "global_fetch_strictly_public"]

[[routes]]
pattern = "${HOST}"
custom_domain = true          # CF provisions DNS + TLS for this host (free under ctxlayer.net)

[assets]
directory = "./apps/web/dist"
binding = "ASSETS"
not_found_handling = "single-page-application"
run_worker_first = ["/api/*","/mcp","/mcp/*","/sse","/sse/*","/cli","/cli/*","/oauth/*","/idp/*","/collab/*","/.well-known/*"]

[[d1_databases]]
binding = "DB"
database_name = "${WORKER}"
database_id = "${D1_ID}"
migrations_dir = "apps/worker/src/db/migrations"

[[kv_namespaces]]
binding = "OAUTH_KV"
id = "${KV_ID}"

[[r2_buckets]]
binding = "DOCS_BUCKET"
bucket_name = "${WORKER}-docs"

[[vectorize]]
binding = "DOCS_INDEX"
index_name = "${WORKER}-docs"
[[vectorize]]
binding = "DOCS_LEXICAL_INDEX"
index_name = "${WORKER}-docs-lexical"

[ai]
binding = "AI"

[[durable_objects.bindings]]
name = "MCP_SESSION_DO"
class_name = "McpSessionDO"
[[durable_objects.bindings]]
name = "DOC_ROOM_DO"
class_name = "DocRoomDO"
[[migrations]]
tag = "v1"
new_classes = ["DocRoomDO"]
new_sqlite_classes = ["McpSessionDO"]

[[queues.producers]]
binding = "USAGE_QUEUE"
queue = "${WORKER}-usage"
[[queues.producers]]
binding = "DOC_REINDEX_QUEUE"
queue = "${WORKER}-reindex"
[[queues.producers]]
binding = "GIT_SYNC_QUEUE"
queue = "${WORKER}-git-sync"
[[queues.consumers]]
queue = "${WORKER}-usage"
max_batch_size = 100
max_batch_timeout = 5
[[queues.consumers]]
queue = "${WORKER}-reindex"
max_batch_size = 10
max_batch_timeout = 30
[[queues.consumers]]
queue = "${WORKER}-git-sync"
max_batch_size = 5
max_batch_timeout = 30

[triggers]
crons = ["0 3 * * *", "0 * * * *"]
```

## `scripts/release-all.sh` (Phase 3 — the part people forget)

A new commit **and every new migration** (e.g. `0018`) must reach every
tenant. Migrate before deploy.

```bash
#!/usr/bin/env bash
set -euo pipefail
bun run build:web
for s in $(jq -r 'keys[]' tenants.json); do
  wrangler d1 migrations apply "ctxlayer-$s" --remote -c "wrangler.$s.toml"
  wrangler deploy -c "wrangler.$s.toml" \
    --var PUBLIC_BASE_URL:"https://$s.ctxlayer.net" \
    --var GIT_SHA:"$(git rev-parse --short HEAD)"
  curl -fsS "https://$s.ctxlayer.net/api/health" | jq -e '.ok' >/dev/null && echo "✓ $s"
done
```

## Scaling ceiling (when B stops being free)

Each tenant consumes **1 D1 · 2 Vectorize · 3 queues · 1 R2 · 1 KV · 1
Worker script**. D1 / R2 / KV scale to thousands per account, but
**Vectorize indexes (2N) and Queues (3N) hit per-account limits fastest.**

- **≲ dozens of tenants:** pure B as above — full isolation, free.
- **More:** either consolidate the shared-able stores (one Vectorize /
  one queue with `tenant_id` in metadata / message — reintroduces a
  little multitenancy code) or move to WfP. Keep **D1 + R2 + secrets**
  per-tenant regardless — cheap isolation, and the parts that matter most
  for blast radius.

## Open items / next steps

- Pick the IdP strategy (per-tenant OAuth App vs central `auth.` host).
- Register `ctxlayer.net`, delegate NS to Cloudflare (full zone).
- Stand up the secret store + `tenants.json` registry.
- Land `scripts/provision-tenant.sh`, `wrangler.template.toml`,
  `scripts/release-all.sh` as real files + a `deprovision-tenant.sh`.
- Verify current per-account Vectorize-index + Queue limits against the
  expected tenant count.
