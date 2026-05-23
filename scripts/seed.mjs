#!/usr/bin/env bun
// Load fixture upstreams + docs into D1. Defaults to --local; --remote
// must be explicit so a stray invocation can't touch production.

import { spawnSync } from 'node:child_process'

const args = process.argv.slice(2)
const remote = args.includes('--remote')
const target = remote ? '--remote' : '--local'

if (remote) {
  console.log('⚠  Seeding REMOTE D1 (production). Ctrl-C within 3s to abort.')
  await new Promise((r) => setTimeout(r, 3000))
}

// M2a: doc fixtures are created through the UI (sign in → "+ New doc")
// because every doc needs a real created_by user, and we don't want
// the seed script to bypass the IdP allowlist by inserting a fake
// user row. M4 will add upstream fixtures here (no auth dependency).
console.log(`Seeding D1 (${target})... (no fixtures yet; placeholder)`)

const result = spawnSync(
  'wrangler',
  ['d1', 'execute', 'DB', target, '--command', 'SELECT 1'],
  { stdio: 'inherit' }
)
process.exit(result.status ?? 1)
