import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../env'
import { accessTrustConfigured, verifyCfAccessJwt } from './cf-access'

const AUD = 'test-aud-tag'
const NOW = 1_700_000_000

function b64url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const b64urlStr = (s: string) => b64url(new TextEncoder().encode(s))

async function genKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256'
    },
    true,
    ['sign', 'verify']
  ) as Promise<CryptoKeyPair>
}

async function jwkFor(pub: CryptoKey, kid: string): Promise<Record<string, unknown>> {
  const jwk = (await crypto.subtle.exportKey('jwk', pub)) as JsonWebKey
  return { ...jwk, kid, alg: 'RS256' }
}

async function signJwt(
  privateKey: CryptoKey,
  kid: string,
  claims: Record<string, unknown>
): Promise<string> {
  const h = b64urlStr(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }))
  const p = b64urlStr(JSON.stringify(claims))
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    new TextEncoder().encode(`${h}.${p}`)
  )
  return `${h}.${p}.${b64url(new Uint8Array(sig))}`
}

// Each test gets its own team domain so the verifier's per-team JWKS cache
// never bleeds across tests (and matches reality: one team domain per deploy).
let n = 0
async function setup() {
  n += 1
  const team = `t${n}.cloudflareaccess.com`
  const kid = `kid-${n}`
  const env = { CF_ACCESS_TEAM_DOMAIN: team, CF_ACCESS_AUD: AUD } as Env
  const pair = await genKeyPair()
  const published = [await jwkFor(pair.publicKey, kid)]
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (String(url) === `https://${team}/cdn-cgi/access/certs`) {
        return new Response(JSON.stringify({ keys: published }), { status: 200 })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
  )
  const claims = (over: Record<string, unknown> = {}) => ({
    iss: `https://${team}`,
    aud: AUD,
    email: 'User@Yuki.be',
    sub: 'sub-123',
    exp: NOW + 300,
    ...over
  })
  return { env, team, kid, key: pair, claims }
}

afterEach(() => vi.unstubAllGlobals())

describe('accessTrustConfigured', () => {
  it('is true only when both team domain and AUD are set', () => {
    expect(accessTrustConfigured({ CF_ACCESS_TEAM_DOMAIN: 't', CF_ACCESS_AUD: 'a' } as Env)).toBe(
      true
    )
    expect(accessTrustConfigured({ CF_ACCESS_TEAM_DOMAIN: 't' } as Env)).toBe(false)
    expect(accessTrustConfigured({} as Env)).toBe(false)
  })
})

describe('verifyCfAccessJwt', () => {
  it('accepts a valid token and returns the lower-cased identity', async () => {
    const t = await setup()
    const jwt = await signJwt(t.key.privateKey, t.kid, t.claims())
    expect(await verifyCfAccessJwt(jwt, t.env, NOW)).toEqual({
      sub: 'sub-123',
      email: 'user@yuki.be',
      name: null
    })
  })

  it('accepts an array aud that includes the configured AUD', async () => {
    const t = await setup()
    const jwt = await signJwt(t.key.privateKey, t.kid, t.claims({ aud: ['other', AUD] }))
    expect(await verifyCfAccessJwt(jwt, t.env, NOW)).not.toBeNull()
  })

  it('rejects a wrong audience', async () => {
    const t = await setup()
    const jwt = await signJwt(t.key.privateKey, t.kid, t.claims({ aud: 'someone-else' }))
    expect(await verifyCfAccessJwt(jwt, t.env, NOW)).toBeNull()
  })

  it('rejects a wrong issuer', async () => {
    const t = await setup()
    const jwt = await signJwt(
      t.key.privateKey,
      t.kid,
      t.claims({ iss: 'https://evil.cloudflareaccess.com' })
    )
    expect(await verifyCfAccessJwt(jwt, t.env, NOW)).toBeNull()
  })

  it('rejects an expired token', async () => {
    const t = await setup()
    const jwt = await signJwt(t.key.privateKey, t.kid, t.claims({ exp: NOW - 1 }))
    expect(await verifyCfAccessJwt(jwt, t.env, NOW)).toBeNull()
  })

  it('rejects a token signed by an untrusted key (kid present, sig mismatched)', async () => {
    const t = await setup()
    const attacker = await genKeyPair() // not in the published JWKS
    const jwt = await signJwt(attacker.privateKey, t.kid, t.claims())
    expect(await verifyCfAccessJwt(jwt, t.env, NOW)).toBeNull()
  })

  it('rejects a tampered payload', async () => {
    const t = await setup()
    const jwt = await signJwt(t.key.privateKey, t.kid, t.claims())
    const [h, , s] = jwt.split('.')
    const forged = b64urlStr(JSON.stringify(t.claims({ email: 'attacker@evil.com' })))
    expect(await verifyCfAccessJwt(`${h}.${forged}.${s}`, t.env, NOW)).toBeNull()
  })

  it('returns null when Access trust is not configured', async () => {
    expect(await verifyCfAccessJwt('a.b.c', {} as Env, NOW)).toBeNull()
  })

  it('returns null for a malformed token', async () => {
    const t = await setup()
    expect(await verifyCfAccessJwt('not-a-jwt', t.env, NOW)).toBeNull()
  })
})
