import { defineConfig } from 'vitest/config'

// Unit tests for pure helpers (CSRF token equality, slugify, etc).
// Cloudflare-specific integration tests live in
// `vitest.integration.config.ts` and use `@cloudflare/vitest-pool-workers`
// to talk to a real D1 — exclude them here so `bun run test` stays a
// fast node-only loop and `bun run test:int` runs them separately.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['test/integration/**', '**/*.integration.test.ts', 'node_modules/**'],
    environment: 'node',
    globals: false
  }
})
