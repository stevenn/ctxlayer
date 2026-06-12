import { describe, expect, it } from 'vitest'
import { gitStaticOAuth, parseGitAuthConfig } from './git-oauth'
import type { GitSourceRow } from '../db/queries/git-sources'

// gitStaticOAuth only reads `auth_config`; a partial cast keeps the test lean.
function source(authConfig: string | null): GitSourceRow {
  return { auth_config: authConfig } as unknown as GitSourceRow
}

const fullOauth = JSON.stringify({
  oauth: {
    clientId: 'cid',
    authorizeUrl: 'https://gitlab.com/oauth/authorize',
    tokenUrl: 'https://gitlab.com/oauth/token',
    scopes: ['api'],
    clientSecretCiphertext: 'sealed:xyz'
  }
})

describe('gitStaticOAuth', () => {
  it('returns null when no usable oauth config is present', () => {
    expect(gitStaticOAuth(source(null))).toBeNull()
    expect(gitStaticOAuth(source('{}'))).toBeNull()
    expect(gitStaticOAuth(source('not json'))).toBeNull()
    // missing tokenUrl + authorizeUrl
    expect(gitStaticOAuth(source(JSON.stringify({ oauth: { clientId: 'x' } })))).toBeNull()
  })

  it('returns the config once clientId + authorize + token URLs are all set', () => {
    const cfg = gitStaticOAuth(source(fullOauth))
    expect(cfg).not.toBeNull()
    expect(cfg?.clientId).toBe('cid')
    expect(cfg?.tokenUrl).toBe('https://gitlab.com/oauth/token')
    expect(cfg?.scopes).toEqual(['api'])
  })
})

describe('parseGitAuthConfig', () => {
  it('returns {} for null / malformed JSON', () => {
    expect(parseGitAuthConfig(null)).toEqual({})
    expect(parseGitAuthConfig('nope')).toEqual({})
  })

  it('round-trips a stored oauth block', () => {
    expect(parseGitAuthConfig(fullOauth).oauth?.clientId).toBe('cid')
  })
})
