#!/usr/bin/env node
// Seed fixtures via `wrangler d1 execute`. Real seed payloads land with M2/M4
// — this is the entry point so the slash command works today.

import { spawnSync } from 'node:child_process'

const local = process.argv.includes('--local')
const target = local ? '--local' : '--remote'

console.log(`Seeding D1 (${target})... (no fixtures yet; placeholder)`)

const result = spawnSync(
  'wrangler',
  ['d1', 'execute', 'DB', target, '--command', 'SELECT 1'],
  { stdio: 'inherit' }
)
process.exit(result.status ?? 1)
