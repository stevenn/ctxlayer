import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Vite dev server runs on 5173 and proxies API/MCP traffic to the local
// Worker (`wrangler dev`) on 8787. In production the Worker serves both.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8787',
      '/oauth': 'http://localhost:8787',
      '/idp': 'http://localhost:8787',
      '/mcp': 'http://localhost:8787',
      '/sse': 'http://localhost:8787',
      '/collab': { target: 'ws://localhost:8787', ws: true },
      '/.well-known': 'http://localhost:8787'
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true
  }
})
