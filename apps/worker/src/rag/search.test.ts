import { describe, it, expect } from 'vitest'
import { effectiveScope, retrieveCandidates } from './search'
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
// gitDocIdsAmong runs against DB; the stub returns no git docs so the
// scope filter alone governs these cases.
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

  it('undefined defaults to open-read (search every doc)', () => {
    expect(effectiveScope(undefined, user)).toEqual({
      teams: [],
      products: [],
      includeGlobal: true,
      all: true
    })
  })

  it('intersects supplied ids with the reachable set (no escalation)', () => {
    const eff = effectiveScope({ teams: ['t1', 't9'], products: ['p9'] }, user)
    expect(eff.teams).toEqual(['t1'])
    expect(eff.products).toEqual([])
  })
})

describe('retrieveCandidates', () => {
  it('keeps global + in-scope chunks, drops out-of-scope, sorts by cosine', async () => {
    const env = makeEnv([
      { score: 0.9, metadata: chunk({ docId: 'a', chunkIdx: 0, is_global: true }) },
      {
        score: 0.8,
        metadata: chunk({ docId: 'b', chunkIdx: 0, is_global: false, tag_teams: ['t1'] })
      },
      {
        score: 0.7,
        metadata: chunk({ docId: 'c', chunkIdx: 0, is_global: false, tag_teams: ['t2'] })
      }
    ])
    const candidates = await retrieveCandidates(env, ['q'], {
      effective: { teams: ['t1'], products: [], includeGlobal: true, all: false }
    })
    expect(candidates.map((c) => c.metadata.docId)).toEqual(['a', 'b'])
    expect(candidates[0]?.denseScore).toBe(0.9)
  })

  it('drops candidates below the low candidate floor', async () => {
    const env = makeEnv([
      { score: 0.9, metadata: chunk({ docId: 'a', chunkIdx: 0 }) },
      { score: 0.1, metadata: chunk({ docId: 'b', chunkIdx: 0 }) } // below CANDIDATE_FLOOR (0.3)
    ])
    const candidates = await retrieveCandidates(env, ['q'], {
      effective: { teams: [], products: [], includeGlobal: true, all: true }
    })
    expect(candidates.map((c) => c.metadata.docId)).toEqual(['a'])
  })

  it('merges duplicate chunk ids across multiple queries', async () => {
    const env = makeEnv([
      { score: 0.9, metadata: chunk({ docId: 'a', chunkIdx: 0 }) },
      { score: 0.8, metadata: chunk({ docId: 'a', chunkIdx: 1 }) }
    ])
    // Two queries → query() runs twice, same matches each time. The
    // chunk-id dedupe must collapse them, not return four candidates.
    const candidates = await retrieveCandidates(env, ['q1', 'q2'], {
      effective: { teams: [], products: [], includeGlobal: true, all: true }
    })
    expect(candidates).toHaveLength(2)
  })

  it('respects the candidate limit', async () => {
    const env = makeEnv([
      { score: 0.9, metadata: chunk({ docId: 'a', chunkIdx: 0 }) },
      { score: 0.8, metadata: chunk({ docId: 'b', chunkIdx: 0 }) },
      { score: 0.7, metadata: chunk({ docId: 'c', chunkIdx: 0 }) }
    ])
    const candidates = await retrieveCandidates(env, ['q'], {
      effective: { teams: [], products: [], includeGlobal: true, all: true },
      limit: 2
    })
    expect(candidates.map((c) => c.metadata.docId)).toEqual(['a', 'b'])
  })
})
