import { defineConfig } from 'vitest/config'

// Unit tests for pure helpers (CSRF token equality, slugify, etc).
// Cloudflare-specific integration tests will land in a separate
// `vitest.integration.config.ts` using `@cloudflare/vitest-pool-workers`
// once the D1+R2 fixtures are wired (M2a follow-up). Until then this
// node-env config is enough to cover the pure code we have.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    globals: false
  }
})
