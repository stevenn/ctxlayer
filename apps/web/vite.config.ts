import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Vite dev server (5173) proxies API / MCP / OAuth / collab WS traffic to
// the local Worker (`wrangler dev` on 8787). `target` must be http(s)://
// even for WS upgrades; http-proxy handles the upgrade via `ws: true`.
// `changeOrigin: true` rewrites the Host header so the Worker sees its
// own origin and signed cookies round-trip.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8787', changeOrigin: true },
      '/oauth': { target: 'http://localhost:8787', changeOrigin: true },
      '/idp': { target: 'http://localhost:8787', changeOrigin: true },
      '/mcp': { target: 'http://localhost:8787', changeOrigin: true },
      '/sse': { target: 'http://localhost:8787', changeOrigin: true },
      '/collab': { target: 'http://localhost:8787', changeOrigin: true, ws: true },
      '/.well-known': { target: 'http://localhost:8787', changeOrigin: true }
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true
  }
})
