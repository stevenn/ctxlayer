#!/usr/bin/env bun
/**
 * Deploy (or upload a preview of) the Worker, injecting PUBLIC_BASE_URL from a
 * gitignored `.prod.vars` so the committed wrangler.toml stays a clean public
 * template. Usage:
 *
 *   bun scripts/deploy.mjs                         # wrangler deploy (base wrangler.toml)
 *   bun scripts/deploy.mjs --preview               # wrangler versions upload
 *   bun scripts/deploy.mjs --config wrangler.dev.toml
 *                                                  # per-host deploy (multi-tenant; pass
 *                                                  #   PUBLIC_BASE_URL=https://<host> in the env)
 *
 * `.prod.vars` holds NON-SECRET plaintext config only (deployment origin).
 * Real secrets (ENCRYPTION_KEY, IdP creds, …) go via `wrangler secret put`.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const preview = process.argv.includes('--preview')
// Optional per-host config (multi-tenant). When set, passed to wrangler as
// `-c <path>` so the same GIT_SHA/BUILT_AT stamping covers every tenant.
const configIdx = process.argv.indexOf('--config')
const configPath = configIdx !== -1 ? process.argv[configIdx + 1] : null

// Parse a `.prod.vars` (KEY=VALUE lines, `#` comments). Returns {} if absent.
function loadProdVars() {
  const path = join(repoRoot, '.prod.vars')
  if (!existsSync(path)) return {}
  const out = {}
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq > 0) out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  return out
}

const fileVars = loadProdVars()
const publicBaseUrl = process.env.PUBLIC_BASE_URL || fileVars.PUBLIC_BASE_URL
// Personal-login allowlist for the BASE deploy only. Injected from `.prod.vars`
// (or the env) so the committed wrangler.toml stays a generic public template,
// exactly like PUBLIC_BASE_URL. Tenant (`--config`) deploys are intentionally
// excluded below: their allowlist is the per-host rendered [vars] (the ops
// registry), and a global value here would clobber it (e.g. wrongly enable a
// Google-only tenant's GitHub). Absent → the committed "" default stands.
const githubUsers = process.env.ALLOWED_GITHUB_USERS ?? fileVars.ALLOWED_GITHUB_USERS

if (!publicBaseUrl || /YOUR-WORKER|example\.workers\.dev/.test(publicBaseUrl)) {
  console.error(
    '\n[deploy] PUBLIC_BASE_URL is not set.\n' +
      '  Create a gitignored .prod.vars at the repo root with your origin:\n' +
      '    PUBLIC_BASE_URL=https://<your-worker>.workers.dev\n' +
      '  (or export PUBLIC_BASE_URL=…). See README → Deploying ctxlayer.\n'
  )
  process.exit(1)
}

const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot })
  .toString()
  .trim()
const builtAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

const vars = [
  ['PUBLIC_BASE_URL', publicBaseUrl],
  ['GIT_SHA', sha],
  ['BUILT_AT', builtAt]
]
// Base deploy only — see githubUsers above. Tenant configs carry their own.
if (!configPath && githubUsers) vars.push(['ALLOWED_GITHUB_USERS', githubUsers])
const varArgs = vars.flatMap(([k, v]) => ['--var', `${k}:${v}`])
const configArgs = configPath ? ['-c', configPath] : []
const wranglerArgs = preview
  ? ['versions', 'upload', ...configArgs, ...varArgs]
  : ['deploy', ...configArgs, ...varArgs]

// HSTS for the static-asset responses (the SPA shell + /assets/*, which
// bypass the worker). We inject it here — at deploy/preview time — rather
// than committing it into `apps/web/public/_headers`, because an HSTS
// header served by `wrangler dev` over https://localhost would pin the
// browser's whole `localhost` to HTTPS and break other local dev servers.
// Real deploys (incl. `--preview`) are always HTTPS hosts. Idempotent so
// the per-tenant loop in ops `release-all.sh` (one build, many deploys)
// doesn't append duplicates. Matches the worker-side value in
// apps/worker/src/util/security-headers.ts.
function injectAssetHsts() {
  const headersPath = join(repoRoot, 'apps/web/dist/_headers')
  if (!existsSync(headersPath)) return
  const current = readFileSync(headersPath, 'utf8')
  if (/strict-transport-security/i.test(current)) return
  // The file has a single `/*` rule (all paths); appending an indented
  // header line at EOF attaches it to that rule.
  const line = '  Strict-Transport-Security: max-age=31536000; includeSubDomains'
  writeFileSync(headersPath, `${current.replace(/\s*$/, '')}\n${line}\n`)
  console.error('[deploy] injected HSTS into apps/web/dist/_headers')
}
injectAssetHsts()

console.error(`[deploy] PUBLIC_BASE_URL=${publicBaseUrl}`)
console.error(`[deploy] wrangler ${wranglerArgs.join(' ')}`)
// Run from the original cwd (apps/worker); wrangler resolves the root config
// + `[assets] directory` relative to wrangler.toml regardless of cwd.
execFileSync('bunx', ['wrangler', ...wranglerArgs], { stdio: 'inherit' })
