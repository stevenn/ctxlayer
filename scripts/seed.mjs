#!/usr/bin/env bun
// Load fixture rows (teams + products) into D1. Defaults to --local;
// --remote must be explicit so a stray invocation can't touch
// production. The seeded ids are deterministic so re-running is
// idempotent (INSERT OR IGNORE).
//
// M4 will add upstream_servers fixtures here too. Docs are NOT
// seeded — every doc needs a real created_by user, and we don't
// want to bypass the IdP allowlist by inserting a fake user row.

import { spawnSync } from 'node:child_process'

const args = process.argv.slice(2)
const remote = args.includes('--remote')
const target = remote ? '--remote' : '--local'

if (remote) {
  console.log('⚠  Seeding REMOTE D1 (production). Ctrl-C within 3s to abort.')
  await new Promise((r) => setTimeout(r, 3000))
}

// Deterministic ids (lowercased, dashes stripped) so re-runs are idempotent.
const now = Math.floor(Date.now() / 1000)
const teams = [
  { id: 'seedteamplatform', slug: 'team-platform', name: 'Platform', desc: 'Core infra + DX' },
  { id: 'seedteamweb', slug: 'team-web', name: 'Web', desc: 'Frontend + SPA' },
  { id: 'seedteamdata', slug: 'team-data', name: 'Data', desc: 'Analytics + pipelines' }
]
const products = [
  { id: 'seedprodcheckout', slug: 'prod-checkout', name: 'Checkout', desc: 'Payment flow' },
  { id: 'seedprodsearch', slug: 'prod-search', name: 'Search', desc: 'Discovery surfaces' }
]

const stmts = []
for (const t of teams) {
  stmts.push(
    `INSERT OR IGNORE INTO teams (id, slug, display_name, description, created_at, updated_at) ` +
      `VALUES ('${t.id}', '${t.slug}', '${t.name}', '${t.desc}', ${now}, ${now});`
  )
}
for (const p of products) {
  stmts.push(
    `INSERT OR IGNORE INTO products (id, slug, display_name, description, created_at, updated_at) ` +
      `VALUES ('${p.id}', '${p.slug}', '${p.name}', '${p.desc}', ${now}, ${now});`
  )
}
const sql = stmts.join('\n')

console.log(`Seeding D1 (${target}) — ${teams.length} teams + ${products.length} products…`)

const result = spawnSync('wrangler', ['d1', 'execute', 'DB', target, '--command', sql], {
  stdio: 'inherit'
})
process.exit(result.status ?? 1)
