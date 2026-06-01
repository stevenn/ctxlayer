import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Unit/component tests run under jsdom with Testing Library. Kept separate
// from vite.config.ts so the dev-server's HTTPS-cert loading never runs here.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false
  }
})
