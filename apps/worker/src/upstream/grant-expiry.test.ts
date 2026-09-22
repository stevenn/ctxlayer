import { describe, it, expect } from 'vitest'
import {
  GRANT_EXPIRY_WARN_DAYS,
  MIN_GRANT_OBSERVATIONS,
  observedGrantDays,
  resolveGrantExpiry
} from '@ctxlayer/shared'
import { captureRefreshExpiry, parseRefreshExpiry } from './token-expiry'

/**
 * The three answers to "when does this authorization die", and the order they
 * beat each other in: what the provider said > what we measured > what an
 * admin typed. The shared helpers are pure; they live under the worker suite
 * because the shared package has no runner of its own.
 */

const NOW = 1_800_000_000
const DAY = 86400

describe('resolveGrantExpiry precedence', () => {
  const grantedAt = NOW - 10 * DAY

  it('takes the provider at its word over everything else', () => {
    const out = resolveGrantExpiry(
      {
        providerExpiresAt: NOW + 5 * DAY,
        grantedAt,
        observedDays: 14,
        configuredDays: 30
      },
      NOW
    )
    expect(out).toMatchObject({ source: 'provider', daysLeft: 5 })
    expect(out?.expiresAt).toBe(NOW + 5 * DAY)
  })

  it('falls to what we measured when the provider says nothing', () => {
    const out = resolveGrantExpiry({ grantedAt, observedDays: 14, configuredDays: 30 }, NOW)
    // 10 days in on a measured 14-day life.
    expect(out).toMatchObject({ source: 'observed', daysLeft: 4 })
  })

  it('falls to the admin guess only when nothing better exists', () => {
    const out = resolveGrantExpiry({ grantedAt, configuredDays: 30 }, NOW)
    expect(out).toMatchObject({ source: 'configured', daysLeft: 20 })
  })

  it('is null when nothing can say — no guessing from thin air', () => {
    expect(resolveGrantExpiry({ grantedAt }, NOW)).toBeNull()
    expect(resolveGrantExpiry({ observedDays: 14 }, NOW)).toBeNull()
    expect(resolveGrantExpiry({}, NOW)).toBeNull()
  })

  it('warns inside the window and stays warning once past', () => {
    const soon = resolveGrantExpiry({ providerExpiresAt: NOW + 2 * DAY }, NOW)
    expect(soon?.expiringSoon).toBe(true)
    const later = resolveGrantExpiry(
      { providerExpiresAt: NOW + (GRANT_EXPIRY_WARN_DAYS + 2) * DAY },
      NOW
    )
    expect(later?.expiringSoon).toBe(false)
    const past = resolveGrantExpiry({ providerExpiresAt: NOW - DAY }, NOW)
    expect(past).toMatchObject({ expiringSoon: true, daysLeft: -1 })
  })

  it('reads a sliding provider window as "no cliff" rather than inventing one', () => {
    // A provider that re-reports the same remaining lifetime on every refresh
    // never trips the warning — which is correct: there is no deadline.
    const first = resolveGrantExpiry({ providerExpiresAt: NOW + 30 * DAY }, NOW)
    const later = resolveGrantExpiry({ providerExpiresAt: NOW + 10 * DAY + 30 * DAY }, NOW + 10 * DAY)
    expect(first?.expiringSoon).toBe(false)
    expect(later?.expiringSoon).toBe(false)
  })
})

describe('observedGrantDays', () => {
  it('says nothing until enough authorizations have actually died', () => {
    expect(observedGrantDays([])).toBeNull()
    expect(observedGrantDays([14.2, 14.5])).toBeNull()
    expect(MIN_GRANT_OBSERVATIONS).toBe(3)
  })

  it('reproduces the hand-measured field values', () => {
    expect(observedGrantDays([14.1, 14.4, 14.8, 14.2])).toBe(14)
    expect(observedGrantDays([24.94, 25.02, 24.98])).toBe(24)
    expect(observedGrantDays([30.0, 30.0, 29.9])).toBe(30)
  })

  it('is not dragged down by one user disconnecting by hand', () => {
    // A minimum would answer 0 and warn everyone, every day, forever.
    expect(observedGrantDays([0.1, 14.2, 14.4, 14.6, 14.8])).toBe(14)
  })

  it('follows a provider that changes its policy, as new deaths outvote old', () => {
    expect(observedGrantDays([30, 30, 30, 14, 14, 14, 14])).toBe(14)
  })

  it('refuses a sub-day median rather than warn permanently', () => {
    expect(observedGrantDays([0.2, 0.3, 0.4])).toBeNull()
  })
})

describe('parseRefreshExpiry', () => {
  it('reads the de-facto relative field', () => {
    expect(parseRefreshExpiry({ refresh_token_expires_in: 15552000 }, NOW)).toBe(NOW + 15552000)
  })

  it('accepts the numeric strings form-encoded providers send', () => {
    expect(parseRefreshExpiry({ refresh_token_expires_in: '3600' }, NOW)).toBe(NOW + 3600)
  })

  it('reads the absolute variant some providers use', () => {
    expect(parseRefreshExpiry({ refresh_token_expires_at: NOW + 100 }, NOW)).toBe(NOW + 100)
  })

  it('ignores the access-token lifetime — the field we already had', () => {
    expect(parseRefreshExpiry({ expires_in: 3599, access_token: 'x' }, NOW)).toBeNull()
  })

  it('ignores junk, zero, the past and absurd horizons', () => {
    expect(parseRefreshExpiry({ refresh_token_expires_in: 0 }, NOW)).toBeNull()
    expect(parseRefreshExpiry({ refresh_token_expires_in: -5 }, NOW)).toBeNull()
    expect(parseRefreshExpiry({ refresh_token_expires_in: 'soon' }, NOW)).toBeNull()
    expect(parseRefreshExpiry({ refresh_token_expires_in: 99 * 365 * DAY }, NOW)).toBeNull()
    expect(parseRefreshExpiry({ refresh_token_expires_at: NOW - DAY }, NOW)).toBeNull()
    expect(parseRefreshExpiry(null, NOW)).toBeNull()
    expect(parseRefreshExpiry('nope', NOW)).toBeNull()
  })
})

describe('captureRefreshExpiry', () => {
  const tokenResponse = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

  it('picks the expiry off a token response without consuming it', async () => {
    let seen: number | null = null
    const wrapped = captureRefreshExpiry(
      (at) => {
        seen = at
      },
      async () => tokenResponse({ access_token: 'a', refresh_token_expires_in: 600 })
    )
    const res = await wrapped('https://idp.test/token', { method: 'POST' })
    // The caller still gets an unread body — this sits in the login path.
    expect(await res.json()).toMatchObject({ access_token: 'a' })
    expect(seen).toBeGreaterThan(Math.floor(Date.now() / 1000))
  })

  it('stays out of the way of non-token traffic and failures', async () => {
    let calls = 0
    const onExpiry = () => {
      calls++
    }
    const get = captureRefreshExpiry(onExpiry, async () =>
      tokenResponse({ refresh_token_expires_in: 600 })
    )
    await get('https://idp.test/.well-known/oauth-authorization-server')
    const failing = captureRefreshExpiry(
      onExpiry,
      async () => new Response('nope', { status: 400 })
    )
    await failing('https://idp.test/token', { method: 'POST' })
    expect(calls).toBe(0)
  })

  it('swallows a non-JSON body rather than break the exchange', async () => {
    const wrapped = captureRefreshExpiry(
      () => {
        throw new Error('should not be called')
      },
      async () => new Response('<html>oops</html>', { status: 200 })
    )
    await expect(wrapped('https://idp.test/token', { method: 'POST' })).resolves.toBeInstanceOf(
      Response
    )
  })
})
