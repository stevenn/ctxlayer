import { describe, expect, it } from 'vitest'
import type { Env } from '../env'
import { open, sealedFromString } from '../crypto/aead'
import { UPSTREAM_TIMEOUT_CLAMP_MS } from './http-client'
import {
  clampTimeouts,
  dropLegacyDcrMirror,
  oauthEndpointSelfLoop,
  prepareOAuthSecret,
  preserveDcrClient
} from './admin-config'

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

describe('preserveDcrClient', () => {
  // What D1 holds for a connected DCR upstream…
  const clientInfo = { client_id: 'dcr-123', redirect_uris: ['https://ctx.test/cb'] }
  const current = {
    timeouts: { callMs: 1000 },
    oauth: { client_id: 'dcr-123', client_secret: 'dcr-secret', client_info: clientInfo }
  }
  // …and what the drawer can send back: the read path redacted client_info +
  // client_secret, so an edit never carries them.
  const fromForm = { timeouts: { callMs: 2000 }, grantLifetimeDays: 25, oauth: { client_id: 'dcr-123' } }

  it('re-attaches the registration an ordinary edit cannot round-trip', () => {
    // Without this, saving ANY field re-registered ctxlayer under a new
    // client_id and every user's refresh token died as "issued to another client".
    const out = preserveDcrClient(fromForm, current, true)
    expect(out?.oauth?.client_info).toEqual(clientInfo)
    expect(out?.grantLifetimeDays).toBe(25) // the edit itself still lands
    expect(out?.timeouts).toEqual({ callMs: 2000 })
  })

  it('carries the registration only, not the legacy flat secret mirror', () => {
    // `current` is shaped like a row written before the flat client_id /
    // client_secret mirror was dropped: nothing reads it, and everything the
    // SDK needs is inside client_info, so an edit sheds it.
    const out = preserveDcrClient(fromForm, current, true)
    expect(out?.oauth?.client_secret).toBeUndefined()
  })

  it('also when the form dropped the oauth block entirely', () => {
    const out = preserveDcrClient({ grantLifetimeDays: 14 }, current, true)
    expect(out?.oauth).toEqual({ client_info: clientInfo })
  })

  it('drops it when the registration stops being valid (URL / strategy change)', () => {
    expect(preserveDcrClient(fromForm, current, false)).toBe(fromForm)
  })

  it('a switch to a pre-registered static client wins', () => {
    const toStatic = {
      oauth: {
        clientId: 'app-1',
        authorizeUrl: 'https://idp.example/authorize',
        tokenUrl: 'https://idp.example/token'
      }
    }
    expect(preserveDcrClient(toStatic, current, true)).toBe(toStatic)
  })

  it('is a no-op with nothing to preserve or no config in the patch', () => {
    expect(preserveDcrClient(fromForm, { timeouts: { callMs: 1 } }, true)).toBe(fromForm)
    expect(preserveDcrClient(undefined, current, true)).toBeUndefined()
  })
})

describe('dropLegacyDcrMirror', () => {
  // `oauth.client_id` is not a secret, so the admin read path does not redact
  // it: a drawer save on a row written before the mirror was removed sends it
  // straight back. Stripping it on the write path is what actually retires it.
  it('strips the legacy flat pair a drawer save round-trips back', () => {
    const out = dropLegacyDcrMirror({
      grantLifetimeDays: 25,
      oauth: { client_id: 'dcr-123', client_secret: 'dcr-secret' }
    })
    expect(out?.oauth).toEqual({})
    expect(out?.grantLifetimeDays).toBe(25)
  })

  it('leaves the static/pre-registered camelCase fields alone', () => {
    const cfg = {
      oauth: {
        clientId: 'app-1',
        clientSecret: 'plaintext-from-form',
        authorizeUrl: 'https://idp.example/authorize',
        tokenUrl: 'https://idp.example/token'
      }
    }
    expect(dropLegacyDcrMirror(cfg)).toEqual(cfg)
  })

  it('keeps the registration itself — only the mirror goes', () => {
    const clientInfo = { client_id: 'dcr-123', redirect_uris: ['https://ctx.test/cb'] }
    const out = dropLegacyDcrMirror({ oauth: { client_id: 'dcr-123', client_info: clientInfo } })
    expect(out?.oauth?.client_info).toEqual(clientInfo)
    expect(out?.oauth?.client_id).toBeUndefined()
  })

  it('is a no-op without an oauth block', () => {
    const cfg = { timeouts: { callMs: 1000 } }
    expect(dropLegacyDcrMirror(cfg)).toBe(cfg)
    expect(dropLegacyDcrMirror(undefined)).toBeUndefined()
  })
})
