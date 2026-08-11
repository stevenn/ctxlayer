import { describe, expect, it } from 'vitest'
import type { Env } from '../env'
import { open, sealedFromString } from '../crypto/aead'
import { UPSTREAM_TIMEOUT_CLAMP_MS } from './http-client'
import { clampTimeouts, oauthEndpointSelfLoop, prepareOAuthSecret } from './admin-config'

// 32 random bytes, base64-encoded. Fixed value so the test is deterministic.
const KEY = 'JxQK0aw3pPRtKwhsoa3J9wQVcYAvkjbqcCpPjC4Sh7M='
const env = { ENCRYPTION_KEY: KEY, PUBLIC_BASE_URL: 'https://ctx.example.com' } as Env

describe('clampTimeouts', () => {
  it('passes configs without timeouts through untouched', () => {
    expect(clampTimeouts(undefined)).toBeUndefined()
    const cfg = { oauth: { clientId: 'x' } }
    expect(clampTimeouts(cfg)).toBe(cfg)
  })

  it('clamps every timeout field to the platform hard cap', () => {
    const out = clampTimeouts({
      timeouts: { callMs: UPSTREAM_TIMEOUT_CLAMP_MS + 1, maxCallMs: 10 ** 9, listMs: 5000 }
    })
    expect(out?.timeouts).toEqual({
      callMs: UPSTREAM_TIMEOUT_CLAMP_MS,
      maxCallMs: UPSTREAM_TIMEOUT_CLAMP_MS,
      listMs: 5000
    })
  })

  it('leaves absent fields undefined', () => {
    const out = clampTimeouts({ timeouts: { callMs: 1000 } })
    expect(out?.timeouts?.callMs).toBe(1000)
    expect(out?.timeouts?.maxCallMs).toBeUndefined()
  })
})

describe('prepareOAuthSecret', () => {
  it('is a no-op without an oauth block', async () => {
    expect(await prepareOAuthSecret(undefined, env, undefined)).toBeUndefined()
    const cfg = { timeouts: { callMs: 1 } }
    expect(await prepareOAuthSecret(cfg, env, undefined)).toBe(cfg)
  })

  it('seals a new clientSecret and strips the plaintext', async () => {
    const out = await prepareOAuthSecret(
      { oauth: { clientId: 'id', clientSecret: 'hunter2' } },
      env,
      undefined
    )
    expect(out?.oauth?.clientSecret).toBeUndefined()
    const ct = out?.oauth?.clientSecretCiphertext
    expect(ct).toBeTruthy()
    expect(await open(sealedFromString(ct as string), KEY)).toBe('hunter2')
  })

  it('carries the existing ciphertext forward when no new secret is supplied', async () => {
    const out = await prepareOAuthSecret(
      { oauth: { clientId: 'id' } },
      env,
      { oauth: { clientSecretCiphertext: 'existing-sealed' } }
    )
    expect(out?.oauth?.clientSecretCiphertext).toBe('existing-sealed')
    expect(out?.oauth?.clientSecret).toBeUndefined()
  })
})

describe('oauthEndpointSelfLoop', () => {
  it('is false without an oauth block', () => {
    expect(oauthEndpointSelfLoop(undefined, env)).toBe(false)
    expect(oauthEndpointSelfLoop({ timeouts: {} }, env)).toBe(false)
  })

  it('rejects authorize or token URLs pointing back at this deployment', () => {
    expect(
      oauthEndpointSelfLoop({ oauth: { authorizeUrl: 'https://ctx.example.com/oauth/x' } }, env)
    ).toBe(true)
    expect(
      oauthEndpointSelfLoop({ oauth: { tokenUrl: 'https://ctx.example.com:443/token' } }, env)
    ).toBe(true)
  })

  it('accepts external endpoints', () => {
    expect(
      oauthEndpointSelfLoop(
        { oauth: { authorizeUrl: 'https://idp.example.org/a', tokenUrl: 'https://idp.example.org/t' } },
        env
      )
    ).toBe(false)
  })
})
