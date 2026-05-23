import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// HTTPS dev cert is only needed when running `vite` (the dev server).
// `vite build` and `tsc --noEmit` must not require the cert to exist —
// CI and cold checkouts may not have run `scripts/setup-dev-tls.mjs`
// yet. defineConfig's function form gives us {command} so we can load
// the cert lazily only for command === 'serve'.
export default defineConfig(({ command }) => {
  const httpsConfig = command === 'serve' ? loadDevTls() : undefined

  // Vite dev server (5173, HTTPS) proxies API / MCP / OAuth / collab
  // traffic to the local Worker (wrangler dev on 8787, HTTPS). `secure:
  // false` lets the proxy trust the same locally-signed cert;
  // `changeOrigin: true` rewrites the Host header so the Worker sees
  // its own origin and signed cookies round-trip. WS upgrade via
  // `ws: true` for /collab.
  const workerTarget = 'https://localhost:8787'
  const proxyEntry = { target: workerTarget, changeOrigin: true, secure: false }
  const wsProxyEntry = { ...proxyEntry, ws: true }

  return {
    plugins: [react()],
    server: {
      port: 5173,
      https: httpsConfig,
      proxy: {
        '/api': proxyEntry,
        '/oauth': proxyEntry,
        '/idp': proxyEntry,
        '/mcp': proxyEntry,
        '/sse': proxyEntry,
        '/collab': wsProxyEntry,
        '/.well-known': proxyEntry
      }
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      sourcemap: true
    }
  }
})

function loadDevTls(): { key: Buffer; cert: Buffer } | undefined {
  const tlsDir = resolve(__dirname, '../../.dev-tls')
  try {
    return {
      key: readFileSync(resolve(tlsDir, 'localhost-key.pem')),
      cert: readFileSync(resolve(tlsDir, 'localhost.pem'))
    }
  } catch {
    console.warn(
      [
        '',
        'vite: .dev-tls cert not found. The HTTPS dev server will fall back to HTTP,',
        '      which breaks the __Host- session cookie. Run `bun run dev` from the',
        '      repo root (or `bun scripts/setup-dev-tls.mjs`) to generate the cert.',
        ''
      ].join('\n')
    )
    return undefined
  }
}
