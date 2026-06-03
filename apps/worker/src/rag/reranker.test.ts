import { describe, it, expect } from 'vitest'
import { applyRerank, parseRerankResponse, type Candidate } from './reranker'
import type { ChunkMetadata } from './index'

function cand(docId: string, denseScore = 0.5): Candidate {
  const metadata: ChunkMetadata = {
    docId,
    chunkIdx: 0,
    revisionId: 'r1',
    title: docId,
    headings: [],
    tag_teams: [],
    tag_products: [],
    is_global: true,
    text: `body ${docId}`
  }
  return { metadata, denseScore }
}

describe('parseRerankResponse', () => {
  it('parses the documented { response: [{id,score}] } shape', () => {
    const items = parseRerankResponse({ response: [{ id: 1, score: 2.5 }, { id: 0, score: -1 }] })
    expect(items).toEqual([{ id: 1, score: 2.5 }, { id: 0, score: -1 }])
  })

  it('returns null for a missing/non-array response (→ caller falls back)', () => {
    expect(parseRerankResponse(null)).toBeNull()
    expect(parseRerankResponse({})).toBeNull()
    expect(parseRerankResponse({ response: 'nope' })).toBeNull()
    expect(parseRerankResponse({ response: [] })).toBeNull()
  })

  it('drops malformed items but keeps the well-formed ones', () => {
    const items = parseRerankResponse({
      response: [{ id: 0, score: 1 }, { id: 'x', score: 1 }, { foo: 1 }, { id: 2, score: 0 }]
    })
    expect(items).toEqual([{ id: 0, score: 1 }, { id: 2, score: 0 }])
  })
})

describe('applyRerank', () => {
  const candidates = [cand('a'), cand('b'), cand('c')]

  it('maps ids→candidates, floors on sigmoid, sorts desc, slices k', () => {
    // sigmoid: 2 → 0.88 (keep), -2 → 0.12 (drop @floor 0.5), 0 → 0.5 (keep)
    const out = applyRerank(
      candidates,
      [{ id: 0, score: 2 }, { id: 1, score: -2 }, { id: 2, score: 0 }],
      { k: 5, floor: 0.5 }
    )
    expect(out.map((r) => r.candidate.metadata.docId)).toEqual(['a', 'c'])
    expect(out[0]?.rerankScore).toBeGreaterThan(out[1]?.rerankScore ?? 1)
  })

  it('reorders against the dense order (rerank wins)', () => {
    // dense order is a,b,c; reranker prefers c, then a, then b
    const out = applyRerank(
      candidates,
      [{ id: 0, score: 0.2 }, { id: 1, score: -0.5 }, { id: 2, score: 3 }],
      { k: 3, floor: 0 }
    )
    expect(out.map((r) => r.candidate.metadata.docId)).toEqual(['c', 'a', 'b'])
  })

  it('respects k', () => {
    const out = applyRerank(
      candidates,
      [{ id: 0, score: 1 }, { id: 1, score: 2 }, { id: 2, score: 3 }],
      { k: 1, floor: 0 }
    )
    expect(out).toHaveLength(1)
    expect(out[0]?.candidate.metadata.docId).toBe('c')
  })

  it('ignores ids out of range', () => {
    const out = applyRerank(candidates, [{ id: 9, score: 5 }, { id: 0, score: 1 }], {
      k: 5,
      floor: 0
    })
    expect(out.map((r) => r.candidate.metadata.docId)).toEqual(['a'])
  })
})
