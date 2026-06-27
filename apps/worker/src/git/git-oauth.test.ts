import { describe, expect, it } from 'vitest'
import { gitStaticOAuth, parseGitAuthConfig } from './git-oauth'

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
    expect(gitStaticOAuth(null)).toBeNull()
    expect(gitStaticOAuth('{}')).toBeNull()
    expect(gitStaticOAuth('not json')).toBeNull()
    // missing tokenUrl + authorizeUrl
    expect(gitStaticOAuth(JSON.stringify({ oauth: { clientId: 'x' } }))).toBeNull()
  })

  it('returns the config once clientId + authorize + token URLs are all set', () => {
    const cfg = gitStaticOAuth(fullOauth)
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
