import { describe, it, expect } from 'vitest'
import { lexicalTokens, lexicalVector, LEXICAL_DIM } from './lexical-embed'

/** Both vectors are L2-normalised, so cosine == dot product. */
function cosine(a: number[], b: number[]): number {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += (a[i] as number) * (b[i] as number)
  return dot
}

describe('lexicalTokens', () => {
  it('lowercases, drops stopwords, keeps ≥2-char tokens WITH duplicates', () => {
    expect(lexicalTokens('The VAT and the VAT rate')).toEqual(['vat', 'vat', 'rate'])
  })

  it('keeps short identifiers/acronyms (≥2) that significantTerms would drop', () => {
    expect(lexicalTokens('VB DB id')).toEqual(['vb', 'db', 'id'])
  })
})

describe('lexicalVector', () => {
  it('returns null for stopword-only / empty input', () => {
    expect(lexicalVector('the and for with')).toBeNull()
    expect(lexicalVector('   ')).toBeNull()
    expect(lexicalVector('')).toBeNull()
  })

  it('produces a unit-length LEXICAL_DIM vector', () => {
    const v = lexicalVector('WebSession tenant database resolution')
    expect(v).not.toBeNull()
    expect(v).toHaveLength(LEXICAL_DIM)
    expect(cosine(v as number[], v as number[])).toBeCloseTo(1, 5)
  })

  it('is deterministic', () => {
    expect(lexicalVector('multi tenant VAT')).toEqual(lexicalVector('multi tenant VAT'))
  })

  it('shared terms → positive cosine; disjoint terms → near-zero and lower', () => {
    const a = lexicalVector('vat country rules') as number[]
    const b = lexicalVector('vat calculation country') as number[]
    const c = lexicalVector('banana elephant guitar') as number[]
    const shared = cosine(a, b)
    const disjoint = cosine(a, c)
    expect(shared).toBeGreaterThan(0)
    expect(shared).toBeGreaterThan(disjoint)
    expect(disjoint).toBeLessThan(0.1)
  })
})
