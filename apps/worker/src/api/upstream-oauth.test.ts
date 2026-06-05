import { describe, it, expect } from 'vitest'
import { isReauthSignal } from './upstream-oauth'

// isReauthSignal gates a credential WIPE during reconnect, so it must
// fire on genuine auth-rejection signals and stay quiet on transient
// network/5xx failures (where wiping creds + re-auth would be wrong).
describe('isReauthSignal', () => {
  it('matches Linear -32002 + generic re-auth phrasing', () => {
    const linear =
      'Streamable HTTP error: Error POSTing to endpoint: {"jsonrpc":"2.0","error":{"code":-32002,"message":"Session expired. Please re-authenticate."},"id":null}'
    expect(isReauthSignal(linear)).toBe(true)
    expect(isReauthSignal('Session expired. Please re-authenticate.')).toBe(true)
    expect(isReauthSignal('please reauthenticate')).toBe(true)
    expect(isReauthSignal('401 Unauthorized')).toBe(true)
    expect(isReauthSignal('invalid_token')).toBe(true)
    expect(isReauthSignal('invalid token')).toBe(true)
  })

  it('does NOT match transient / non-auth failures (no creds wipe)', () => {
    expect(isReauthSignal('Streamable HTTP error: 500 Internal Server Error')).toBe(false)
    expect(isReauthSignal('503 Service Unavailable')).toBe(false)
    expect(isReauthSignal('fetch failed')).toBe(false)
    expect(isReauthSignal('request timed out')).toBe(false)
    expect(isReauthSignal('ECONNRESET')).toBe(false)
  })

  it('is safe on empty / missing input', () => {
    expect(isReauthSignal(undefined)).toBe(false)
    expect(isReauthSignal(null)).toBe(false)
    expect(isReauthSignal('')).toBe(false)
  })
})
