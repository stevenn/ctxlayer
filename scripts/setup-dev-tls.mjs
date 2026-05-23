#!/usr/bin/env bun
// Generate a locally-trusted TLS cert for `localhost` + `127.0.0.1` so that
// `wrangler dev` and `vite` can serve HTTPS in dev. The `__Host-` session
// cookie prefix requires Secure, which the browser only honours over HTTPS.
//
// Idempotent: if cert + key already exist, this script is a no-op. Runs as
// the `predev` hook on both apps/worker and apps/web.

import { existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const dir = resolve(root, '.dev-tls')
const certPath = resolve(dir, 'localhost.pem')
const keyPath = resolve(dir, 'localhost-key.pem')

if (existsSync(certPath) && existsSync(keyPath)) {
  process.exit(0)
}

// mkcert installed?
const which = spawnSync('which', ['mkcert'])
if (which.status !== 0) {
  console.error(
    [
      '',
      'setup-dev-tls: mkcert is required for local HTTPS dev.',
      '  macOS:   brew install mkcert nss',
      '  Linux:   https://github.com/FiloSottile/mkcert#installation',
      '',
      'After installing, re-run `bun run dev` (this script is idempotent).',
      ''
    ].join('\n')
  )
  process.exit(1)
}

mkdirSync(dir, { recursive: true })

// One-time CA registration. Re-running is safe; it just reports "already
// installed in the system trust store".
const install = spawnSync('mkcert', ['-install'], { stdio: 'inherit' })
if (install.status !== 0) {
  console.error('setup-dev-tls: `mkcert -install` failed')
  process.exit(install.status ?? 1)
}

const make = spawnSync(
  'mkcert',
  ['-cert-file', certPath, '-key-file', keyPath, 'localhost', '127.0.0.1'],
  { stdio: 'inherit', cwd: dir }
)
if (make.status !== 0) {
  console.error('setup-dev-tls: cert generation failed')
  process.exit(make.status ?? 1)
}

console.log(`setup-dev-tls: wrote ${certPath} and ${keyPath}`)
