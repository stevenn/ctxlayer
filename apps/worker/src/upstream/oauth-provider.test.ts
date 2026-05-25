/**
 * Unit tests for the parts of UpstreamOAuthProvider that don't talk to
 * an MCP upstream — clientMetadata shape, state-token stability,
 * verifier KV round-trip, token seal/open round-trip.
 *
 * The actual auth(provider, ...) orchestration is exercised end-to-end
 * via the OAuth start/callback routes; mocking the SDK here would
 * mostly assert that the mock behaves the way we mocked it.
 */
import { describe, expect, it } from 'vitest'
import { UpstreamOAuthProvider } from './oauth-provider'
import type { Env } from '../env'
import type { UpstreamServerRow } from '../db/queries/upstreams'

const ENCRYPTION_KEY = 'JxQK0aw3pPRtKwhsoa3J9wQVcYAvkjbqcCpPjC4Sh7M='

function makeKv() {
  const store = new Map<string, string>()
  return {
    store,
    kv: {
      async get(key: string) {
        return store.has(key) ? store.get(key)! : null
      },
      async put(key: string, value: string, _opts?: unknown) {
        store.set(key, value)
      },
      async delete(key: string) {
        store.delete(key)
      }
    }
  }
}

interface MutableUpstream {
  row: UpstreamServerRow
  credByUser: Map<string, { ciphertext: Uint8Array; iv: Uint8Array; keyVersion: number; kind: 'bearer' | 'oauth' }>
}

function makeUpstream(): MutableUpstream {
  const row: UpstreamServerRow = {
    id: 'u1',
    slug: 'notion',
    display_name: 'Notion',
    transport: 'streamable_http',
    url: 'https://mcp.notion.com/mcp',
    auth_strategy: 'user_oauth',
    auth_config: '{}',
    enabled: 1,
    created_at: 1700000000,
    updated_at: 1700000000
  }
  return { row, credByUser: new Map() }
}

function makeEnv(state: MutableUpstream, kv: ReturnType<typeof makeKv>['kv']): Env {
  const env: Partial<Env> = {
    ENCRYPTION_KEY,
    PUBLIC_BASE_URL: 'https://ctxlayer.example/',
    OAUTH_KV: kv as unknown as Env['OAUTH_KV'],
    DB: {
      prepare(sql: string) {
        return {
          bind(...binds: unknown[]) {
            return {
              async first() {
                if (sql.includes('FROM user_credentials')) {
                  const [userId] = binds as [string, string]
                  const c = state.credByUser.get(userId)
                  if (!c) return null
                  return {
                    user_id: userId,
                    upstream_id: state.row.id,
                    kind: c.kind,
                    ciphertext: c.ciphertext,
                    iv: c.iv,
                    key_version: c.keyVersion,
                    created_at: 0,
                    updated_at: 0
                  }
                }
                return null
              },
              async all() {
                return { results: [] }
              },
              async run() {
                if (sql.startsWith('INSERT INTO user_credentials')) {
                  const [userId, _id, kind, ciphertext, iv, keyVersion] = binds as [
                    string,
                    string,
                    'bearer' | 'oauth',
                    Uint8Array,
                    Uint8Array,
                    number
                  ]
                  state.credByUser.set(userId, { kind, ciphertext, iv, keyVersion })
                }
                if (sql.startsWith('UPDATE upstream_servers')) {
                  // Capture an auth_config update.
                  for (let i = 0; i < binds.length - 1; i++) {
                    const v = binds[i]
                    if (typeof v === 'string' && v.startsWith('{')) {
                      state.row.auth_config = v
                    }
                  }
                }
                return { success: true, meta: {} }
              }
            }
          }
        }
      },
      async batch() {
        return []
      }
    } as unknown as Env['DB']
  }
  return env as Env
}

describe('UpstreamOAuthProvider', () => {
  it('returns a stable redirect_uri based on PUBLIC_BASE_URL', () => {
    const up = makeUpstream()
    const env = makeEnv(up, makeKv().kv)
    const p = new UpstreamOAuthProvider(env, up.row, 'user-1')
    expect(p.redirectUrl).toBe('https://ctxlayer.example/api/upstreams/oauth/callback')
    expect(p.clientMetadata.redirect_uris).toEqual([p.redirectUrl])
    expect(p.clientMetadata.grant_types).toEqual(['authorization_code', 'refresh_token'])
    expect(p.clientMetadata.token_endpoint_auth_method).toBe('none')
  })

  it('state() is stable within an instance, fresh across instances', () => {
    const up = makeUpstream()
    const env = makeEnv(up, makeKv().kv)
    const a = new UpstreamOAuthProvider(env, up.row, 'user-1')
    expect(a.state()).toBe(a.state())
    const b = new UpstreamOAuthProvider(env, up.row, 'user-1')
    expect(b.state()).not.toBe(a.state())
  })

  it('saveCodeVerifier writes a row keyed by state, codeVerifier reads it back', async () => {
    const up = makeUpstream()
    const { kv, store } = makeKv()
    const env = makeEnv(up, kv)
    const provider = new UpstreamOAuthProvider(env, up.row, 'user-1')
    const state = provider.state()
    await provider.saveCodeVerifier('the-verifier')
    expect(store.has(`outbound:verifier:${state}`)).toBe(true)
    expect(await provider.codeVerifier()).toBe('the-verifier')
  })

  it('callback-side provider reads the verifier the start-side wrote', async () => {
    const up = makeUpstream()
    const { kv } = makeKv()
    const env = makeEnv(up, kv)
    const start = new UpstreamOAuthProvider(env, up.row, 'user-1')
    const state = start.state()
    await start.saveCodeVerifier('v-1')

    const callback = new UpstreamOAuthProvider(env, up.row, 'user-1', state)
    expect(callback.state()).toBe(state)
    expect(await callback.codeVerifier()).toBe('v-1')
  })

  it('saveTokens seals + stores, tokens() decrypts back', async () => {
    const up = makeUpstream()
    const env = makeEnv(up, makeKv().kv)
    const provider = new UpstreamOAuthProvider(env, up.row, 'user-1')
    await provider.saveTokens({
      access_token: 'at',
      token_type: 'Bearer',
      refresh_token: 'rt',
      scope: 'read write',
      expires_in: 3600
    })
    const out = await provider.tokens()
    expect(out?.access_token).toBe('at')
    expect(out?.refresh_token).toBe('rt')
    expect(out?.scope).toBe('read write')
    // expires_in survives the round-trip approximately (we re-derive it
    // from the persisted absolute expires_at). Allow a small skew.
    expect(out?.expires_in).toBeGreaterThan(3590)
    expect(out?.expires_in).toBeLessThanOrEqual(3600)
  })

  it('tokens() returns undefined when no credential row exists', async () => {
    const up = makeUpstream()
    const env = makeEnv(up, makeKv().kv)
    const provider = new UpstreamOAuthProvider(env, up.row, 'no-one')
    expect(await provider.tokens()).toBeUndefined()
  })

  it('saveClientInformation persists into upstream auth_config.oauth', async () => {
    const up = makeUpstream()
    const env = makeEnv(up, makeKv().kv)
    const provider = new UpstreamOAuthProvider(env, up.row, 'user-1')
    await provider.saveClientInformation({
      client_id: 'cid',
      client_secret: 'csec',
      redirect_uris: ['https://ctxlayer.example/api/upstreams/oauth/callback']
    })
    const cfg = JSON.parse(up.row.auth_config) as { oauth?: { client_id?: string } }
    expect(cfg.oauth?.client_id).toBe('cid')
    // And clientInformation() reads it back.
    const info = await provider.clientInformation()
    expect(info?.client_id).toBe('cid')
  })

  it('redirectToAuthorization captures the URL for the route layer to 302 to', () => {
    const up = makeUpstream()
    const env = makeEnv(up, makeKv().kv)
    const provider = new UpstreamOAuthProvider(env, up.row, 'user-1')
    expect(provider.capturedRedirect).toBeNull()
    provider.redirectToAuthorization(new URL('https://upstream.example/authorize?x=1'))
    expect(provider.capturedRedirect?.toString()).toBe('https://upstream.example/authorize?x=1')
  })
})
