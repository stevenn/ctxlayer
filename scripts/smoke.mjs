#!/usr/bin/env bun
// Mobile-friendly smoke test. Pass a base URL or rely on $CTXLAYER_URL.
// Prints a compact text table and exits non-zero if any check fails.

const base = (process.argv[2] ?? process.env.CTXLAYER_URL ?? 'http://localhost:8787')
  .replace(/\/$/, '')

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
  // .well-known OAuth metadata: returns 501 until M2 wires the OAuth
  // provider; once wired it returns 200.
  {
    name: 'oauth-meta',
    method: 'GET',
    path: '/.well-known/oauth-authorization-server',
    expect: [200, 501]
  },
  // MCP initialize JSON-RPC frame. Pre-M2 the route returns 501; post-M2
  // an unauthenticated call returns 401 from the OAuth provider.
  {
    name: 'mcp-init',
    method: 'POST',
    path: '/mcp',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    expect: [200, 401, 501]
  },
  // SPA shell. With `not_found_handling = "single-page-application"` and
  // a populated dist/index.html, an unknown SPA path MUST return 200
  // HTML. 404 means the dist is missing.
  { name: 'spa-shell', method: 'GET', path: '/sign-in', expect: [200] }
]

let failed = 0
const rows = []
for (const c of checks) {
  const url = base + c.path
  const start = Date.now()
  try {
    const res = await fetch(url, { method: c.method, headers: c.headers, body: c.body })
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
