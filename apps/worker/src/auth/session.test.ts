import { describe, expect, it } from 'vitest'
import { b64urlEncode } from '../util/base64url'
import { hmacSign, signSession, verifySession } from './session'

const SECRET = 'session-unit-test-secret'

describe('session epoch (A7)', () => {
  it('round-trips the epoch through sign → verify', async () => {
    const cookie = await signSession({ userId: 'u1', role: 'user', epoch: 3 }, SECRET)
    const payload = await verifySession(cookie, SECRET)
    expect(payload).toMatchObject({ userId: 'u1', role: 'user', epoch: 3 })
  })

  it('defaults a mint without an epoch to 0', async () => {
    const cookie = await signSession({ userId: 'u1', role: 'user' }, SECRET)
    expect((await verifySession(cookie, SECRET))?.epoch).toBe(0)
  })

  it('normalises a pre-A7 cookie (no epoch field) to epoch 0', async () => {
    // Hand-craft the legacy payload shape — signSession always writes an
    // epoch now, but 30-day cookies minted before the deploy are still live.
    const now = Math.floor(Date.now() / 1000)
    const legacy = { userId: 'u1', role: 'user', iat: now, exp: now + 3600 }
    const body = b64urlEncode(new TextEncoder().encode(JSON.stringify(legacy)))
    const cookie = `${body}.${await hmacSign(body, SECRET)}`
    const payload = await verifySession(cookie, SECRET)
    expect(payload?.epoch).toBe(0)
  })
})
