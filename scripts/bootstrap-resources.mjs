#!/usr/bin/env bun
/**
 * Provision the Cloudflare resources ctxlayer needs and patch
 * `wrangler.toml` with the real IDs. Idempotent — skips any binding
 * that already has a non-placeholder id.
 *
 *   D1 database       (ctxlayer)
 *   KV namespace      (OAUTH_KV)
 *   R2 bucket         (ctxlayer-docs) — no id, just create
 *   Vectorize index   (ctxlayer-docs)
 *
 * Requires `wrangler login` (or CLOUDFLARE_API_TOKEN + ACCOUNT_ID in
 * env). Re-run any time without harm.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const TOML = 'wrangler.toml'
const DB_NAME = 'ctxlayer'
const KV_NAME = 'OAUTH_KV'
const R2_BUCKET = 'ctxlayer-docs'
const VECTORIZE_NAME = 'ctxlayer-docs'

const PLACEHOLDER_RE = /^0+(-0+)*$/

let toml = readFileSync(TOML, 'utf8')
let dirty = false

function patch(pattern, replacement) {
  const next = toml.replace(pattern, replacement)
  if (next === toml) return false
  toml = next
  dirty = true
  return true
}

function run(args) {
  console.log('→', 'wrangler', args.join(' '))
  const res = spawnSync('wrangler', args, {
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8'
  })
  if (res.status !== 0) {
    console.error(`wrangler ${args[0]} failed (exit ${res.status}). aborting.`)
    process.exit(res.status ?? 1)
  }
  return res.stdout ?? ''
}

// ----- D1 ---------------------------------------------------------------
const dbMatch = toml.match(
  /\[\[d1_databases\]\][\s\S]*?database_id\s*=\s*"([0-9a-fA-F-]+)"/
)
if (!dbMatch) {
  console.error('Could not find d1_databases.database_id in wrangler.toml')
  process.exit(1)
}
const currentDbId = dbMatch[1]
if (PLACEHOLDER_RE.test(currentDbId)) {
  console.log(`\nProvisioning D1 database "${DB_NAME}"…`)
  const out = run(['d1', 'create', DB_NAME])
  const idMatch = out.match(/database_id\s*=\s*"([^"]+)"/)
  if (!idMatch) {
    console.error('Could not parse database_id from wrangler output:\n' + out)
    process.exit(1)
  }
  patch(/database_id\s*=\s*"[^"]*"\s*#\s*<TODO>/, `database_id = "${idMatch[1]}"`)
  console.log(`✓ D1 id: ${idMatch[1]}`)
} else {
  console.log(`✓ D1 already provisioned (id: ${currentDbId})`)
}

// ----- KV ---------------------------------------------------------------
const kvMatch = toml.match(/\[\[kv_namespaces\]\][\s\S]*?id\s*=\s*"([0-9a-fA-F]+)"/)
if (!kvMatch) {
  console.error('Could not find kv_namespaces.id in wrangler.toml')
  process.exit(1)
}
const currentKvId = kvMatch[1]
if (PLACEHOLDER_RE.test(currentKvId)) {
  console.log(`\nProvisioning KV namespace "${KV_NAME}"…`)
  const out = run(['kv', 'namespace', 'create', KV_NAME])
  // Output looks like: id = "abc123..."
  const idMatch = out.match(/id\s*=\s*"([0-9a-fA-F]+)"/)
  if (!idMatch) {
    console.error('Could not parse KV id from wrangler output:\n' + out)
    process.exit(1)
  }
  patch(/(\[\[kv_namespaces\]\][\s\S]*?id\s*=\s*)"[^"]*"\s*#\s*<TODO>/, `$1"${idMatch[1]}"`)
  console.log(`✓ KV id: ${idMatch[1]}`)
} else {
  console.log(`✓ KV already provisioned (id: ${currentKvId})`)
}

// ----- R2 ---------------------------------------------------------------
// Buckets are referenced by name only, no id to patch. Create if missing;
// wrangler errors on "already exists" with a code we tolerate.
console.log(`\nEnsuring R2 bucket "${R2_BUCKET}"…`)
const r2 = spawnSync('wrangler', ['r2', 'bucket', 'create', R2_BUCKET], {
  stdio: ['ignore', 'pipe', 'pipe'],
  encoding: 'utf8'
})
if (r2.status === 0) {
  console.log(`✓ R2 bucket created`)
} else if ((r2.stderr ?? '').toLowerCase().includes('already exists')) {
  console.log(`✓ R2 bucket already exists`)
} else {
  console.error(`R2 bucket create failed (exit ${r2.status}):\n${r2.stderr ?? r2.stdout}`)
  process.exit(r2.status ?? 1)
}

// ----- Vectorize --------------------------------------------------------
// Vectorize is referenced by index name (no id). Check existence by trying
// to list and grepping the name; create if missing.
console.log(`\nEnsuring Vectorize index "${VECTORIZE_NAME}"…`)
const list = spawnSync('wrangler', ['vectorize', 'list'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  encoding: 'utf8'
})
const exists = (list.stdout ?? '').includes(VECTORIZE_NAME)
if (exists) {
  console.log(`✓ Vectorize index already exists`)
} else {
  run([
    'vectorize',
    'create',
    VECTORIZE_NAME,
    '--dimensions=768',
    '--metric=cosine',
    '--description=ctxlayer doc chunks (bge-base-en-v1.5 embeddings)'
  ])
  console.log(`✓ Vectorize index created`)
}

// ----- write back -------------------------------------------------------
if (dirty) {
  writeFileSync(TOML, toml)
  console.log(`\nPatched ${TOML} with real IDs.`)
} else {
  console.log(`\nNo changes to ${TOML}.`)
}
console.log('\nNext: bun run dev — bindings should resolve to real resources now.')
