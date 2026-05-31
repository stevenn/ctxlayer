import { describe, it, expect } from 'vitest'
import { effectiveScope, searchChunks } from './search'
import type { ChunkMetadata } from './index'
import type { Env } from '../env'

const DIM = 768
const vec = () => new Array(DIM).fill(0.1)

function chunk(over: Partial<ChunkMetadata>): ChunkMetadata {
  return {
    docId: 'd1',
    chunkIdx: 0,
    revisionId: 'r1',
    title: 'Doc',
    headings: ['H1'],
    tag_teams: [],
    tag_products: [],
    is_global: true,
    text: 'body',
    ...over
  }
}

// Stub Env: AI.run echoes one 768-d vector per input text; DOCS_INDEX
// returns the supplied matches for every query (vector is ignored).
function makeEnv(matches: Array<{ score: number; metadata: ChunkMetadata }>): Env {
  return {
    AI: {
      run: async (_model: string, input: { text: string[] }) => ({
        data: input.text.map(() => vec()),
        shape: [input.text.length, DIM]
      })
    },
    DOCS_INDEX: {
      query: async () => ({ matches })
    },
    // gitDocIdsAmong runs against DB; stub returns no git docs so the
    // scope filter alone governs these cases.
    DB: {
      prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) })
    }
  } as unknown as Env
}

describe('effectiveScope', () => {
  const user = { teams: ['t1', 't2'], products: ['p1'] }

  it('"all" disables filtering', () => {
    expect(effectiveScope('all', user)).toEqual({
      teams: [],
      products: [],
      includeGlobal: true,
      all: true
    })
  })

  it('undefined falls back to the user scope + global', () => {
    expect(effectiveScope(undefined, user)).toEqual({
      teams: ['t1', 't2'],
      products: ['p1'],
      includeGlobal: true,
      all: false
    })
  })

  it('intersects supplied ids with the reachable set (no escalation)', () => {
    const eff = effectiveScope({ teams: ['t1', 't9'], products: ['p9'] }, user)
    expect(eff.teams).toEqual(['t1'])
    expect(eff.products).toEqual([])
  })
})

describe('searchChunks', () => {
  it('keeps global + in-scope chunks, drops out-of-scope, sorts by score', async () => {
    const env = makeEnv([
      { score: 0.9, metadata: chunk({ docId: 'a', chunkIdx: 0, is_global: true }) },
      { score: 0.8, metadata: chunk({ docId: 'b', chunkIdx: 0, is_global: false, tag_teams: ['t1'] }) },
      { score: 0.7, metadata: chunk({ docId: 'c', chunkIdx: 0, is_global: false, tag_teams: ['t2'] }) }
    ])
    const hits = await searchChunks(env, ['q'], {
      k: 8,
      effective: { teams: ['t1'], products: [], includeGlobal: true, all: false }
    })
    expect(hits.map((h) => h.docId)).toEqual(['a', 'b'])
    expect(hits[0]?.score).toBe(0.9)
  })

  it('respects k', async () => {
    const env = makeEnv([
      { score: 0.9, metadata: chunk({ docId: 'a', chunkIdx: 0 }) },
      { score: 0.8, metadata: chunk({ docId: 'b', chunkIdx: 0 }) }
    ])
    const hits = await searchChunks(env, ['q'], {
      k: 1,
      effective: { teams: [], products: [], includeGlobal: true, all: true }
    })
    expect(hits).toHaveLength(1)
    expect(hits[0]?.docId).toBe('a')
  })

  it('merges duplicate chunk ids across multiple queries', async () => {
    const env = makeEnv([
      { score: 0.9, metadata: chunk({ docId: 'a', chunkIdx: 0 }) },
      { score: 0.8, metadata: chunk({ docId: 'a', chunkIdx: 1 }) }
    ])
    // Two queries → query() runs twice, same matches each time. The
    // chunk-id dedupe must collapse them, not return four hits.
    const hits = await searchChunks(env, ['q1', 'q2'], {
      k: 8,
      effective: { teams: [], products: [], includeGlobal: true, all: true }
    })
    expect(hits).toHaveLength(2)
  })

  it('truncates long snippets with an ellipsis', async () => {
    const long = 'x'.repeat(2000)
    const env = makeEnv([{ score: 0.5, metadata: chunk({ text: long }) }])
    const hits = await searchChunks(env, ['q'], {
      k: 8,
      effective: { teams: [], products: [], includeGlobal: true, all: true }
    })
    expect(hits[0]?.snippet).toHaveLength(600)
    expect(hits[0]?.snippet.endsWith('…')).toBe(true)
  })
})
