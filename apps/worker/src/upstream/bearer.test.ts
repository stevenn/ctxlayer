import { describe, expect, it } from 'vitest'
import {
  InvalidClientError,
  InvalidGrantError,
  InvalidScopeError,
  ServerError,
  TemporarilyUnavailableError,
  TooManyRequestsError,
  UnauthorizedClientError
} from '@modelcontextprotocol/sdk/server/auth/errors.js'
import { classifyDcrRefreshFailure } from './bearer'
import { UpstreamOAuthProvider } from './oauth-provider'

describe('classifyDcrRefreshFailure', () => {
  it('permanent on structured grant/client death (the flag-worthy class)', () => {
    for (const err of [
      new InvalidGrantError('refresh token expired'),
      new InvalidClientError('unknown client'),
      new UnauthorizedClientError('nope'),
      new InvalidScopeError('scope changed')
    ]) {
      const r = classifyDcrRefreshFailure({ kind: 'threw', err })
      expect(r.permanent).toBe(true)
      expect(r.failure).toContain('sdk_threw:')
    }
  })

  it('transient on 5xx / rate-limit / unavailable OAuth codes (must NOT flag)', () => {
    for (const err of [
      new ServerError('HTTP 500'),
      new TemporarilyUnavailableError('maintenance'),
      new TooManyRequestsError('slow down')
    ]) {
      expect(classifyDcrRefreshFailure({ kind: 'threw', err }).permanent).toBe(false)
    }
  })

  it('transient on non-OAuth throws (network failures during discovery)', () => {
    const r = classifyDcrRefreshFailure({ kind: 'threw', err: new TypeError('fetch failed') })
    expect(r.permanent).toBe(false)
    expect(r.failure).toContain('fetch failed')
  })

  it('redirect with a refresh token present = swallowed unstructured/5xx refresh → transient', () => {
    // The over-flagging class this classification exists for: auth()
    // swallows ServerError/non-OAuth refresh failures and falls through to
    // wanting a new interactive flow.
    const r = classifyDcrRefreshFailure({
      kind: 'redirect',
      result: 'REDIRECT',
      hadRefreshToken: true
    })
    expect(r.permanent).toBe(false)
    expect(r.failure).toBe('sdk_wants_new_authz:REDIRECT')
  })

  it('redirect with NO refresh token = nothing will ever self-heal → permanent', () => {
    const r = classifyDcrRefreshFailure({
      kind: 'redirect',
      result: 'REDIRECT',
      hadRefreshToken: false
    })
    expect(r.permanent).toBe(true)
    expect(r.failure).toBe('no_refresh_token:REDIRECT')
  })
})

describe('classification preconditions', () => {
  it('UpstreamOAuthProvider must NOT implement invalidateCredentials', () => {
    // Load-bearing: if implemented, the SDK's auth() wrapper would wipe the
    // stored tokens on InvalidGrantError and retry into a REDIRECT — which
    // classifyDcrRefreshFailure reads as transient — so a dead grant would
    // never flag AND its tokens (the evidence) would be destroyed.
    expect(
      (UpstreamOAuthProvider.prototype as unknown as Record<string, unknown>)[
        'invalidateCredentials'
      ]
    ).toBeUndefined()
  })
})
