import { describe, expect, it } from 'vitest'
import { upstreamHealth } from './upstreams'

const DAY = 86400
const NOW = 1_800_000_000

describe('upstreamHealth', () => {
  it('no credential → disconnected, plain connect', () => {
    const h = upstreamHealth({ connected: false, needsReauth: false, authExpiresAt: null, authExpiresSource: null }, NOW)
    expect(h).toMatchObject({ kind: 'disconnected', action: 'Connect with OAuth', renewable: false })
  })

  it('a dead authorization is never shown as connected', () => {
    // The page used to render this green: "a credential is on file" was the
    // whole test, so users never learned their authorization had died.
    const h = upstreamHealth({ connected: true, needsReauth: true, authExpiresAt: null, authExpiresSource: null }, NOW)
    expect(h).toMatchObject({ kind: 'needs_reauth', color: 'red', action: 'Re-authorize' })
    expect(h.label).not.toBe('connected')
  })

  it('healthy with no known lifetime → plain reconnect', () => {
    const h = upstreamHealth({ connected: true, needsReauth: false, authExpiresAt: null, authExpiresSource: null }, NOW)
    expect(h).toMatchObject({ kind: 'connected', action: 'Reconnect', renewable: false })
    expect(h.detail).toBeUndefined()
  })

  it('known lifetime, far off → connected, but the button already renews', () => {
    // A plain reconnect only refreshes the token and does NOT restart the
    // provider's clock, so with a known lifetime the action is always Renew.
    const h = upstreamHealth(
      { connected: true, needsReauth: false, authExpiresAt: NOW + 20 * DAY, authExpiresSource: 'configured' },
      NOW
    )
    expect(h).toMatchObject({ kind: 'connected', color: 'green', action: 'Renew', renewable: true })
    expect(h.detail).toMatch(/^valid until /)
  })

  it('inside the warning window → expiring, with a countdown', () => {
    const two = upstreamHealth(
      { connected: true, needsReauth: false, authExpiresAt: NOW + 2 * DAY + 3600, authExpiresSource: 'provider' },
      NOW
    )
    expect(two).toMatchObject({ kind: 'expiring', color: 'yellow', renewable: true })
    expect(two.detail).toBe('expires in 2 days')
    const one = upstreamHealth(
      { connected: true, needsReauth: false, authExpiresAt: NOW + DAY + 60, authExpiresSource: 'provider' },
      NOW
    )
    expect(one.detail).toBe('expires in 1 day')
    const today = upstreamHealth(
      { connected: true, needsReauth: false, authExpiresAt: NOW + 3600, authExpiresSource: 'provider' },
      NOW
    )
    expect(today.detail).toBe('expires today')
  })

  it('hedges the countdown when the date is ctxlayer\'s estimate, not the provider\'s', () => {
    // Stating an inferred date as fact is how a countdown loses its
    // credibility the first time it is a day off.
    const measured = upstreamHealth(
      { connected: true, needsReauth: false, authExpiresAt: NOW + 2 * DAY + 3600, authExpiresSource: 'observed' },
      NOW
    )
    expect(measured.detail).toBe('expires in about 2 days')
    const configured = upstreamHealth(
      { connected: true, needsReauth: false, authExpiresAt: NOW + 20 * DAY, authExpiresSource: 'configured' },
      NOW
    )
    expect(configured.detail).toMatch(/^valid until ~/)
    const reported = upstreamHealth(
      { connected: true, needsReauth: false, authExpiresAt: NOW + 20 * DAY, authExpiresSource: 'provider' },
      NOW
    )
    expect(reported.detail).toMatch(/^valid until [^~]/)
  })
})
