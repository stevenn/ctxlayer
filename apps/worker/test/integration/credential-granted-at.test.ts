import { env } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Env } from '../../src/env'
import type { UpstreamServerRow } from '../../src/db/queries/upstreams'
import { UpstreamOAuthProvider } from '../../src/upstream/oauth-provider'
import { getUserCredentialStatus } from '../../src/db/queries/upstream-credentials'

/**
 * `granted_at` (migration 0036) is the clock an upstream's ABSOLUTE grant
 * lifetime runs from, so it must move on a new authorization and ONLY then:
 *
 *   - a token refresh keeps it (same grant upstream — the provider's clock
 *     did not restart, so ours must not either);
 *   - the callback's code exchange restamps it (new grant);
 *   - a renew start (`forceInteractive`) hides the stored tokens from the
 *     SDK so it goes interactive, WITHOUT touching the working credential.
 */

const ENCRYPTION_KEY = 'JxQK0aw3pPRtKwhsoa3J9wQVcYAvkjbqcCpPjC4Sh7M='
const testEnv = { ...(env as unknown as Env), ENCRYPTION_KEY } as Env

const row: UpstreamServerRow = {
  id: 'ups-g',
  slug: 'up-granted',
  display_name: 'Granted',
  transport: 'streamable_http',
  url: 'https://granted.test/mcp',
  auth_strategy: 'user_oauth',
  auth_config: '{}',
  enabled: 1,
  created_at: 0,
  updated_at: 0
}

const tokens = (access: string) => ({
  access_token: access,
  token_type: 'Bearer',
  refresh_token: `RT-${access}`,
  expires_in: 3600
})

/** Age the stored stamps so a same-second re-save is distinguishable. */
async function backdate(seconds: number): Promise<void> {
  await testEnv.DB.prepare(
    `UPDATE user_credentials
        SET created_at = created_at - ?1, updated_at = updated_at - ?1, granted_at = granted_at - ?1
      WHERE user_id = 'u-g' AND upstream_id = 'ups-g'`
  )
    .bind(seconds)
    .run()
}

beforeEach(async () => {
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO users (id, email, idp, idp_sub, created_at)
       VALUES ('u-g', 'ug@example.test', 'github', 'gh-g', 0)`
    ),
    testEnv.DB.prepare(
      `INSERT INTO upstream_servers
         (id, slug, display_name, transport, url, auth_strategy, auth_config, created_at, updated_at)
       VALUES ('ups-g', 'up-granted', 'Granted', 'streamable_http', 'https://granted.test/mcp', 'user_oauth', '{}', 0, 0)`
    )
  ])
})

afterEach(async () => {
  await testEnv.DB.batch([
    testEnv.DB.prepare(`DELETE FROM user_credentials`),
    testEnv.DB.prepare(`DELETE FROM upstream_servers`),
    testEnv.DB.prepare(`DELETE FROM users`)
  ])
})

describe('user_credentials.granted_at', () => {
  it('is stamped on the first save', async () => {
    const before = Math.floor(Date.now() / 1000)
    await new UpstreamOAuthProvider(testEnv, row, 'u-g').saveTokens(tokens('AT-1'))
    const s = await getUserCredentialStatus(testEnv, 'u-g', 'ups-g')
    expect(s.grantedAt).toBeGreaterThanOrEqual(before)
    expect(s.grantedAt).toBe(s.updatedAt)
  })

  it('a refresh moves updated_at but NOT granted_at', async () => {
    await new UpstreamOAuthProvider(testEnv, row, 'u-g').saveTokens(tokens('AT-1'))
    await backdate(10 * 86400)
    const aged = await getUserCredentialStatus(testEnv, 'u-g', 'ups-g')

    // Start/bearer-path provider (no preset state) = a refresh save.
    await new UpstreamOAuthProvider(testEnv, row, 'u-g').saveTokens(tokens('AT-2'))

    const s = await getUserCredentialStatus(testEnv, 'u-g', 'ups-g')
    expect(s.grantedAt).toBe(aged.grantedAt) // the provider's clock did not restart
    expect(s.updatedAt).toBeGreaterThan(aged.updatedAt ?? 0)
  })

  it('the callback code exchange restamps it (new grant)', async () => {
    await new UpstreamOAuthProvider(testEnv, row, 'u-g').saveTokens(tokens('AT-1'))
    await backdate(10 * 86400)
    const aged = await getUserCredentialStatus(testEnv, 'u-g', 'ups-g')

    // Callback-path provider: constructed with the `?state=` value.
    await new UpstreamOAuthProvider(testEnv, row, 'u-g', 'state-123').saveTokens(tokens('AT-3'))

    const s = await getUserCredentialStatus(testEnv, 'u-g', 'ups-g')
    expect(s.grantedAt).toBeGreaterThan(aged.grantedAt ?? 0)
    expect(s.grantedAt).toBe(s.updatedAt)
  })
})

describe('renew (forceInteractive)', () => {
  it('hides stored tokens from the SDK without touching the credential', async () => {
    await new UpstreamOAuthProvider(testEnv, row, 'u-g').saveTokens(tokens('AT-1'))

    const renewing = new UpstreamOAuthProvider(testEnv, row, 'u-g')
    renewing.forceInteractive = true
    expect(await renewing.tokens()).toBeUndefined() // ⇒ auth() starts an interactive flow

    // The working credential is still there for every other reader.
    const normal = await new UpstreamOAuthProvider(testEnv, row, 'u-g').tokens()
    expect(normal?.access_token).toBe('AT-1')
    expect(normal?.refresh_token).toBe('RT-AT-1')
  })
})
