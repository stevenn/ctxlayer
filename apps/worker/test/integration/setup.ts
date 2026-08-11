import { type D1Migration, applyD1Migrations, env } from 'cloudflare:test'
import { beforeAll } from 'vitest'

/**
 * vitest-pool-workers ≥0.6 types `env` as the project-extensible global
 * `Cloudflare.Env`. Augmenting that globally would force these test-only
 * bindings onto the app `Env` too (agents' McpAgent constrains its generic
 * against `Cloudflare.Env`), so the bindings the integration vitest config
 * provides — the full migration list under `TEST_MIGRATIONS`, applied here so
 * test files don't re-read the SQL at runtime — are typed by a local cast,
 * the same pattern the test files use for the app env.
 */
const testEnv = env as unknown as { DB: D1Database; TEST_MIGRATIONS: D1Migration[] }

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS)
})
