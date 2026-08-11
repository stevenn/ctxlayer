import { env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { credentialFreshnessError } from '../../src/mcp/credential-freshness'
import {
  deleteUserCredential,
  markReauthRequired,
  upsertUserCredential
} from '../../src/db/queries/upstream-credentials'
import { createUpstream } from '../../src/db/queries/upstreams'
import { upsertUser } from '../../src/db/queries/users'
import type { Env as WorkerEnv } from '../../src/env'

/**
 * A6 against real D1: the per-call freshness gate must block a call the
 * moment the user's credential row is deleted (disconnect / admin wipe)
 * or flagged reauth-required — the session-init binding alone would keep
 * the old bearer working until the MCP session dies.
 */

const testEnv = env as unknown as WorkerEnv

let userId: string
let upstreamId: string
let conn: { id: string; slug: string; authStrategy: string }

beforeAll(async () => {
  const { user } = await upsertUser(
    testEnv,
    {
      idp: 'github',
      idpSub: 'fresh-sub-1',
      email: 'fresh-1@test.example',
      name: 'Freshness Test',
      avatarUrl: null
    },
    'active'
  )
  userId = user.id
  const upstream = await createUpstream(testEnv, {
    slug: 'up-fresh-test',
    displayName: 'Freshness Test Upstream',
    transport: 'streamable_http',
    url: 'https://fresh-upstream.test/mcp',
    authStrategy: 'user_bearer',
    authConfig: {},
    enabled: true
  })
  upstreamId = upstream.id
  conn = { id: upstreamId, slug: 'up-fresh-test', authStrategy: 'user_bearer' }
})

async function seedCredential() {
  await upsertUserCredential(testEnv, userId, upstreamId, {
    kind: 'bearer',
    ciphertext: new Uint8Array([1, 2, 3]),
    iv: new Uint8Array([4, 5, 6]),
    keyVersion: 1
  })
}

describe('credentialFreshnessError (A6)', () => {
  it('passes a present, healthy credential', async () => {
    await seedCredential()
    expect(await credentialFreshnessError(testEnv, userId, conn)).toBeNull()
  })

  it('blocks once the credential is flagged reauth-required', async () => {
    await seedCredential()
    await markReauthRequired(testEnv, userId, upstreamId)
    const msg = await credentialFreshnessError(testEnv, userId, conn)
    expect(msg).toContain('credential_revoked')
    expect(msg).toContain('re-authorization')
    expect(msg).toContain('up-fresh-test')
  })

  it('blocks once the credential row is deleted (disconnect / admin wipe)', async () => {
    await seedCredential()
    await deleteUserCredential(testEnv, userId, upstreamId)
    const msg = await credentialFreshnessError(testEnv, userId, conn)
    expect(msg).toContain('credential_revoked')
    expect(msg).toContain('disconnected')
  })

  it('never gates shared/none strategies (org-wide operator config)', async () => {
    for (const authStrategy of ['shared_bearer', 'none']) {
      expect(
        await credentialFreshnessError(testEnv, userId, { ...conn, authStrategy })
      ).toBeNull()
    }
  })
})
