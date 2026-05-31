import { describe, it, expect } from 'vitest'
import { understandQuery, type AvailableScope } from './query-understanding'
import type { Env } from '../env'

const SCOPE: AvailableScope = {
  teams: [{ id: 't1', name: 'Billing' }],
  products: [{ id: 'p1', name: 'Checkout' }]
}

// Stub Env: in-memory KV + an AI.run that returns a scripted response
// (or throws). `kv` is returned so a test can assert on cache writes.
function makeEnv(opts: {
  aiResponse?: string
  aiThrows?: boolean
}): { env: Env; kv: Map<string, string>; calls: () => number } {
  const kv = new Map<string, string>()
  let runCalls = 0
  const env = {
    OAUTH_KV: {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => {
        kv.set(k, v)
      }
    },
    AI: {
      run: async () => {
        runCalls++
        if (opts.aiThrows) throw new Error('ai boom')
        return { response: opts.aiResponse ?? '' }
      }
    }
  } as unknown as Env
  return { env, kv, calls: () => runCalls }
}

describe('understandQuery', () => {
  it('parses valid JSON and keeps only in-scope filter ids', async () => {
    const { env } = makeEnv({
      aiResponse: JSON.stringify({
        rewrittenQuery: 'refund policy',
        expansions: ['how to issue a refund', 'chargeback handling'],
        filters: { teams: ['t1', 't9'], products: ['p9'], topics: ['refunds'] }
      })
    })
    const u = await understandQuery(env, 'how do refunds work', SCOPE)
    expect(u.llmUsed).toBe(true)
    expect(u.rewrittenQuery).toBe('refund policy')
    expect(u.expansions).toHaveLength(2)
    expect(u.filters.teams).toEqual(['t1']) // t9 dropped (not reachable)
    expect(u.filters.products).toEqual([]) // p9 dropped
    expect(u.filters.topics).toEqual(['refunds'])
  })

  it('falls back to the raw query when the model throws', async () => {
    const { env } = makeEnv({ aiThrows: true })
    const u = await understandQuery(env, 'raw query', SCOPE)
    expect(u).toEqual({
      rewrittenQuery: 'raw query',
      expansions: [],
      filters: { teams: [], products: [], topics: [] },
      llmUsed: false
    })
  })

  it('falls back on invalid JSON', async () => {
    const { env } = makeEnv({ aiResponse: 'sorry, I cannot do that' })
    const u = await understandQuery(env, 'raw query', SCOPE)
    expect(u.llmUsed).toBe(false)
    expect(u.rewrittenQuery).toBe('raw query')
  })

  it('extracts JSON from a fenced code block', async () => {
    const { env } = makeEnv({
      aiResponse: '```json\n{"rewrittenQuery":"x","expansions":[],"filters":{}}\n```'
    })
    const u = await understandQuery(env, 'q', SCOPE)
    expect(u.llmUsed).toBe(true)
    expect(u.rewrittenQuery).toBe('x')
  })

  it('caps expansions at 2', async () => {
    const { env } = makeEnv({
      aiResponse: JSON.stringify({
        rewrittenQuery: 'x',
        expansions: ['a', 'b', 'c', 'd'],
        filters: {}
      })
    })
    const u = await understandQuery(env, 'q', SCOPE)
    expect(u.expansions).toEqual(['a', 'b'])
  })

  it('caches a successful interpretation and serves it without a second model call', async () => {
    const { env, calls } = makeEnv({
      aiResponse: JSON.stringify({ rewrittenQuery: 'cached', expansions: [], filters: {} })
    })
    await understandQuery(env, 'same query', SCOPE)
    const second = await understandQuery(env, 'same query', SCOPE)
    expect(second.rewrittenQuery).toBe('cached')
    expect(calls()).toBe(1) // model only hit once; second served from KV
  })
})
