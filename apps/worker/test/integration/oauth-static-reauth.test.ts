import { env } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../../src/env'
import { type UpstreamServerRow, toUpstreamConnection } from '../../src/db/queries/upstreams'
import { resolveUserUpstreamBearer } from '../../src/upstream/bearer'
import { UpstreamOAuthProvider } from '../../src/upstream/oauth-provider'
import { getUserCredentialStatus, markReauthRequired } from '../../src/db/queries/upstream-credentials'

/**
 * End-to-end (real D1) cover for the static-OAuth reauth short-circuit in
 * `resolveUserUpstreamBearer`. The unit tests pin the permanent/transient
 * CLASSIFICATION (oauth-static.test.ts); these pin how `bearer.ts` ACTS on it:
 *
 *   - a credential already flagged for reauth skips the token endpoint entirely
 *     (silencing the repeat "[oauth-static] token refresh failed" log);
 *   - a permanent `invalid_grant` flags reauth, after which the next resolve
 *     short-circuits;
 *   - a transient 5xx does NOT flag, so the upstream keeps retrying instead of
 *     locking the user out.
 *
 * The integration env has no ENCRYPTION_KEY binding, so we pass a spread env
 * with a fixed test key (the same one oauth-provider.test.ts uses) — enough to
 * seal/open the stored tokens. `resolveUserUpstreamBearer` takes env as an
 * argument, so this stays local to the test (no shared-config change).
 */

const ENCRYPTION_KEY = 'JxQK0aw3pPRtKwhsoa3J9wQVcYAvkjbqcCpPjC4Sh7M='
const testEnv = { ...(env as unknown as Env), ENCRYPTION_KEY } as Env

const AUTH_CONFIG = JSON.stringify({
  oauth: {
    clientId: 'app-123',
    authorizeUrl: 'https://login.microsoftonline.com/tid/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/tid/oauth2/v2.0/token',
    scopes: ['x/.default', 'offline_access']
  }
})

const row: UpstreamServerRow = {
  id: 'ups-1',
  slug: 'up-ado',
  display_name: 'ADO',
  transport: 'streamable_http',
  url: 'https://ado.test/mcp',
  auth_strategy: 'user_oauth',
  auth_config: AUTH_CONFIG,
  enabled: 1,
  created_at: 0,
  updated_at: 0
}
const conn = toUpstreamConnection(row)

// Seed a STALE sealed credential: a near-expiry access token plus a refresh
// token, so the fast path falls through to the refresh_token grant.
async function seed(): Promise<void> {
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO users (id, email, idp, idp_sub, created_at)
       VALUES ('u-1', 'u1@example.test', 'github', 'gh-1', 0)`
    ),
    testEnv.DB.prepare(
      `INSERT INTO upstream_servers
         (id, slug, display_name, transport, url, auth_strategy, auth_config, created_at, updated_at)
       VALUES ('ups-1', 'up-ado', 'ADO', 'streamable_http', 'https://ado.test/mcp', 'user_oauth', ?1, 0, 0)`
    ).bind(AUTH_CONFIG)
  ])
  await new UpstreamOAuthProvider(testEnv, row, 'u-1').saveTokens({
    access_token: 'stale-AT',
    token_type: 'Bearer',
    refresh_token: 'RT',
    expires_in: 10
  })
}

async function cleanup(): Promise<void> {
  await testEnv.DB.batch([
    testEnv.DB.prepare(`DELETE FROM user_credentials`),
    testEnv.DB.prepare(`DELETE FROM upstream_servers`),
    testEnv.DB.prepare(`DELETE FROM users`)
  ])
}

// Force the single-flight refresh lease to look expired so the next resolve is
// the lease WINNER and actually re-attempts the refresh (rather than waiting as
// a loser and returning the stored token).
async function expireRefreshLease(): Promise<void> {
  await testEnv.DB.prepare(
    `UPDATE user_credentials SET refresh_lock_until = 1 WHERE user_id = 'u-1' AND upstream_id = 'ups-1'`
  ).run()
}

describe('static-OAuth reauth short-circuit (resolveUserUpstreamBearer)', () => {
  beforeEach(seed)
  afterEach(async () => {
    vi.restoreAllMocks()
    await cleanup()
  })

  it('skips the token endpoint entirely when already flagged for reauth', async () => {
    await markReauthRequired(testEnv, 'u-1', 'ups-1')
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const token = await resolveUserUpstreamBearer(testEnv, row, conn, 'u-1')

    expect(token).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled() // no refresh attempt ⇒ no repeat log
  })

  it('flags reauth on invalid_grant, then short-circuits the next resolve', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }))

    // First resolve: stale token ⇒ refresh ⇒ invalid_grant ⇒ null + flag set.
    expect(await resolveUserUpstreamBearer(testEnv, row, conn, 'u-1')).toBeNull()
    expect(fetchSpy).toHaveBeenCalledOnce()
    expect((await getUserCredentialStatus(testEnv, 'u-1', 'ups-1')).needsReauth).toBe(true)

    // Second resolve: already flagged ⇒ short-circuit, NO second token call.
    expect(await resolveUserUpstreamBearer(testEnv, row, conn, 'u-1')).toBeNull()
    expect(fetchSpy).toHaveBeenCalledOnce()
  })

  it('does NOT flag on a transient 5xx, and keeps retrying', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('upstream down', { status: 503 }))

    expect(await resolveUserUpstreamBearer(testEnv, row, conn, 'u-1')).toBeNull()
    expect((await getUserCredentialStatus(testEnv, 'u-1', 'ups-1')).needsReauth).toBe(false)

    // Not flagged ⇒ no short-circuit. With the lease cleared, the next resolve
    // wins the lease and attempts the refresh again.
    await expireRefreshLease()
    expect(await resolveUserUpstreamBearer(testEnv, row, conn, 'u-1')).toBeNull()
    expect((await getUserCredentialStatus(testEnv, 'u-1', 'ups-1')).needsReauth).toBe(false)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })
})
