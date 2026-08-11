import { createExecutionContext, env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { app } from '../../src/app'
import { signSession } from '../../src/auth/session'
import { bumpSessionEpoch, upsertUser } from '../../src/db/queries/users'
import type { Env as WorkerEnv } from '../../src/env'

/**
 * A7 end-to-end: bumping users.session_epoch (sign-out, admin suspend)
 * must kill every outstanding session cookie at the per-request check —
 * the cookie is a 30-day stateless HMAC bearer, so this epoch match is
 * the ONLY server-side kill switch.
 */

const BASE = 'https://ctxlayer-session-epoch.test'
const SESSION_SECRET = 'session-epoch-integration-secret'

const testEnv = {
  ...(env as unknown as Record<string, unknown>),
  PUBLIC_BASE_URL: BASE,
  SESSION_COOKIE_SECRET: SESSION_SECRET
} as unknown as WorkerEnv

async function seedUser(seq: number) {
  const { user } = await upsertUser(
    testEnv,
    {
      idp: 'github',
      idpSub: `epoch-sub-${seq}`,
      email: `epoch-${seq}@test.example`,
      name: 'Epoch Test',
      avatarUrl: null
    },
    'active'
  )
  return user
}

async function getMe(cookie: string): Promise<Response> {
  return app.request(
    `${BASE}/api/me`,
    { headers: { cookie: `__Host-ctx_session=${cookie}` } },
    testEnv,
    createExecutionContext()
  )
}

describe('session epoch invalidation (A7)', () => {
  it('accepts a cookie minted under the current epoch', async () => {
    const user = await seedUser(1)
    const cookie = await signSession(
      { userId: user.id, role: user.role, epoch: user.session_epoch },
      SESSION_SECRET
    )
    const res = await getMe(cookie)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { id: string }).id).toBe(user.id)
  })

  it('rejects every outstanding cookie once the epoch is bumped', async () => {
    const user = await seedUser(2)
    const cookie = await signSession(
      { userId: user.id, role: user.role, epoch: user.session_epoch },
      SESSION_SECRET
    )
    expect((await getMe(cookie)).status).toBe(200)

    await bumpSessionEpoch(testEnv, user.id)

    const rejected = await getMe(cookie)
    expect(rejected.status).toBe(401)
    // The dead cookie is also cleared so the browser drops it.
    expect(rejected.headers.get('set-cookie')).toContain('__Host-ctx_session=;')

    // A cookie minted under the NEW epoch works — invalidation is not a lockout.
    const fresh = await signSession(
      { userId: user.id, role: user.role, epoch: user.session_epoch + 1 },
      SESSION_SECRET
    )
    expect((await getMe(fresh)).status).toBe(200)
  })

  it('treats a legacy pre-epoch cookie as epoch 0 (valid until first bump)', async () => {
    const user = await seedUser(3)
    // signSession with no epoch mints epoch 0, matching the column default.
    const legacyShaped = await signSession({ userId: user.id, role: user.role }, SESSION_SECRET)
    expect((await getMe(legacyShaped)).status).toBe(200)

    await bumpSessionEpoch(testEnv, user.id)
    expect((await getMe(legacyShaped)).status).toBe(401)
  })
})
