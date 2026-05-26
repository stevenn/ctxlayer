import type { D1Migration } from 'cloudflare:test'
import { applyD1Migrations, env } from 'cloudflare:test'
import { beforeAll } from 'vitest'

/**
 * Ambient extension of the test env. The integration vitest config
 * binds the full migration list under `TEST_MIGRATIONS` so test files
 * can apply schema without re-reading the SQL files at runtime.
 */
declare module 'cloudflare:test' {
  interface ProvidedEnv {
    DB: D1Database
    TEST_MIGRATIONS: D1Migration[]
  }
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
})
