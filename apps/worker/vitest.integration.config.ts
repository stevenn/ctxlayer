import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config'

// Integration tests run against a real D1 (miniflare-backed) database
// with all migrations applied. They live alongside the unit tests but
// use the `*.integration.test.ts` suffix so the default `bun run test`
// doesn't pull them in — they're a bit slower to boot and need workerd.
//
// Migrations are loaded once at config time and exposed to tests
// through a `TEST_MIGRATIONS` binding so a single `setupFiles` hook
// can apply them before each test file runs. Per-test isolation is
// `true` so any rows a test inserts get rolled back at end-of-test.
export default defineWorkersConfig(async () => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const migrationsDir = path.join(here, 'src/db/migrations')
  const migrations = await readD1Migrations(migrationsDir)

  return {
    test: {
      include: ['src/**/*.integration.test.ts', 'test/integration/**/*.test.ts'],
      setupFiles: ['./test/integration/setup.ts'],
      poolOptions: {
        workers: {
          singleWorker: true,
          isolatedStorage: true,
          miniflare: {
            compatibilityDate: '2024-12-30',
            // global_fetch_strictly_public matches wrangler.toml (it gates
            // RFC-1918 fetches in prod). It's also load-bearing here:
            // without it @cloudflare/workers-oauth-provider console.warn()s
            // at module scope, which the patched test console turns into
            // I/O that workerd forbids in global scope — killing any test
            // file that imports the composed app (csrf-gates.test.ts).
            compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
            d1Databases: ['DB'],
            r2Buckets: ['DOCS_BUCKET'],
            bindings: {
              TEST_MIGRATIONS: migrations
            }
          }
        }
      }
    }
  }
})
