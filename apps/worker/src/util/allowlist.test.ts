import { describe, expect, it } from 'vitest'
import { idpAllowlistConfigured, isExplicitlyAllowlisted } from './allowlist'
import type { Env } from '../env'

function env(over: Partial<Env> = {}): Env {
  return {
    ALLOWED_GOOGLE_EMAILS: '',
    ALLOWED_GOOGLE_HD: '',
    ALLOWED_GITHUB_USERS: '',
    ALLOWED_GITHUB_ORG: '',
    ...over
  } as Env
}

describe('isExplicitlyAllowlisted', () => {
  it('matches a GitHub login case-insensitively', () => {
    const e = env({ ALLOWED_GITHUB_USERS: 'Alice, bob' })
    expect(isExplicitlyAllowlisted({ idp: 'github', login: 'ALICE', email: 'a@x', accessToken: 't' }, e)).toBe(true)
    expect(isExplicitlyAllowlisted({ idp: 'github', login: 'carol', email: 'c@x', accessToken: 't' }, e)).toBe(false)
  })

  it('matches a Google email case-insensitively', () => {
    const e = env({ ALLOWED_GOOGLE_EMAILS: 'sam@visma.com' })
    expect(isExplicitlyAllowlisted({ idp: 'google', email: 'SAM@visma.com' }, e)).toBe(true)
    expect(isExplicitlyAllowlisted({ idp: 'google', email: 'nope@visma.com' }, e)).toBe(false)
  })

  it('an org/hd-only config is not an EXPLICIT allowlist', () => {
    expect(
      isExplicitlyAllowlisted(
        { idp: 'github', login: 'alice', email: 'a@x', accessToken: 't' },
        env({ ALLOWED_GITHUB_ORG: 'acme' })
      )
    ).toBe(false)
    expect(isExplicitlyAllowlisted({ idp: 'google', email: 'a@x' }, env({ ALLOWED_GOOGLE_HD: 'x' }))).toBe(false)
  })
})

describe('idpAllowlistConfigured', () => {
  it('true when either the explicit or the domain list is set', () => {
    expect(idpAllowlistConfigured('github', env({ ALLOWED_GITHUB_USERS: 'a' }))).toBe(true)
    expect(idpAllowlistConfigured('github', env({ ALLOWED_GITHUB_ORG: 'acme' }))).toBe(true)
    expect(idpAllowlistConfigured('google', env({ ALLOWED_GOOGLE_HD: 'x' }))).toBe(true)
    expect(idpAllowlistConfigured('google', env({ ALLOWED_GOOGLE_EMAILS: 'a@x' }))).toBe(true)
  })

  it('false when nothing is configured for that IdP', () => {
    expect(idpAllowlistConfigured('github', env())).toBe(false)
    expect(idpAllowlistConfigured('google', env())).toBe(false)
  })
})
