#!/usr/bin/env bun
// Mobile-friendly smoke test. Pass a base URL or rely on $CTXLAYER_URL.
// Prints a compact text table and exits non-zero if any check fails.

const base = (process.argv[2] ?? process.env.CTXLAYER_URL ?? 'http://localhost:8787')
  .replace(/\/$/, '')

// Accept the mkcert-issued cert when hitting localhost. Bun/Node fetch
// doesn't pick up the macOS keychain CA store by default, so
// `https://localhost:8787` otherwise fails with "self signed
// certificate". Restricted to localhost so smoke against a real host
// still verifies TLS.
const isLocalHttps = /^https:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(base)
const tlsExtra = isLocalHttps ? { tls: { rejectUnauthorized: false } } : {}

const checks = [
  { name: 'health',     method: 'GET',  path: '/api/health',   expect: [200, 503] },
  { name: 'version',    method: 'GET',  path: '/api/version',  expect: [200] },
  // Public; the SPA hits this before sign-in.
  { name: 'config',     method: 'GET',  path: '/api/config',   expect: [200] },
  // Without a session cookie /api/me MUST return 401. CI rigs that send
  // a dev session widen this themselves via $SMOKE_ME_OK=1.
  {
    name: 'me-anon',
    method: 'GET',
    path: '/api/me',
    expect: process.env.SMOKE_ME_OK === '1' ? [200, 401] : [401]
  },
  // OAuth metadata is wired (M2c) — MUST be 200 from now on.
  {
    name: 'oauth-meta',
    method: 'GET',
    path: '/.well-known/oauth-authorization-server',
    expect: [200]
  },
  // Anonymous MCP initialize MUST be rejected by the OAuth provider.
  // 401 is the right answer; 200 would mean the provider regressed.
  {
    name: 'mcp-init',
    method: 'POST',
    path: '/mcp',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    expect: [401]
  },
  // SPA shell. With `not_found_handling = "single-page-application"` and
  // a populated dist/index.html, an unknown SPA path MUST return 200
  // HTML. 404 means the dist is missing.
  { name: 'spa-shell', method: 'GET', path: '/sign-in', expect: [200] },
  // M2a: docs API requires a session. Anonymous read MUST be 401, never
  // 200 (would mean the requireUser middleware regressed) and never 501
  // (would mean the route didn't mount).
  { name: 'docs-anon', method: 'GET', path: '/api/docs', expect: [401] },
  // M3a: realtime collab. Plain GET (no Upgrade) MUST be 426 — proves the
  // route mounted. 501 here means the placeholder is still in place.
  { name: 'collab-noupgrade', method: 'GET', path: '/collab/any-doc', expect: [426] }
]

let failed = 0
const rows = []
for (const c of checks) {
  const url = base + c.path
  const start = Date.now()
  try {
    const res = await fetch(url, {
      method: c.method,
      headers: c.headers,
      body: c.body,
      ...tlsExtra
    })
    const ms = Date.now() - start
    const ok = c.expect.includes(res.status)
    rows.push({ name: c.name, ok, status: res.status, ms })
    if (!ok) failed++
  } catch (err) {
    rows.push({
      name: c.name,
      ok: false,
      status: 'ERR',
      ms: Date.now() - start,
      error: String(err)
    })
    failed++
  }
}

console.log(`smoke ${base}\n`)
for (const r of rows) {
  const flag = r.ok ? '✓' : '✗'
  const tail = r.error ? `  ${r.error}` : ''
  console.log(`${flag}  ${r.name.padEnd(12)} ${String(r.status).padEnd(5)} ${r.ms}ms${tail}`)
}
console.log(failed === 0 ? `\npassed (${rows.length}/${rows.length})` : `\nFAILED ${failed}/${rows.length}`)

process.exit(failed === 0 ? 0 : 1)
