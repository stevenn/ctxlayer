#!/usr/bin/env node
// Mobile-friendly smoke test. Pass a base URL or rely on $CTXLAYER_URL.
// Prints a compact text table and exits non-zero if any check fails.

const base = process.argv[2] ?? process.env.CTXLAYER_URL ?? 'http://localhost:8787'

const checks = [
  { name: 'health', method: 'GET', path: '/api/health', expect: [200, 503] },
  { name: 'version', method: 'GET', path: '/api/version', expect: [200] },
  { name: 'me-401', method: 'GET', path: '/api/me', expect: [401] },
  { name: 'spa-shell', method: 'GET', path: '/', expect: [200, 404] }
]

let failed = 0
const rows = []
for (const c of checks) {
  const url = base.replace(/\/$/, '') + c.path
  const start = Date.now()
  try {
    const res = await fetch(url, { method: c.method })
    const ms = Date.now() - start
    const ok = c.expect.includes(res.status)
    rows.push({ name: c.name, ok, status: res.status, ms })
    if (!ok) failed++
  } catch (err) {
    rows.push({ name: c.name, ok: false, status: 'ERR', ms: Date.now() - start, error: String(err) })
    failed++
  }
}

console.log(`smoke ${base}`)
console.log('')
for (const r of rows) {
  const flag = r.ok ? '✓' : '✗'
  console.log(`${flag}  ${r.name.padEnd(12)} ${String(r.status).padEnd(5)} ${r.ms}ms${r.error ? '  ' + r.error : ''}`)
}
console.log('')
console.log(failed === 0 ? `passed (${rows.length}/${rows.length})` : `FAILED ${failed}/${rows.length}`)

process.exit(failed === 0 ? 0 : 1)
