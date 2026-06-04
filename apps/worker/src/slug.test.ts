import { describe, it, expect } from 'vitest'
import { SLUG_PREFIX, prefixedSlug, slugifyBody, suggestSlug } from '@ctxlayer/shared'

describe('slugifyBody', () => {
  it('lowercases, dashes, strips diacritics, falls back to untitled', () => {
    expect(slugifyBody('Hello World')).toBe('hello-world')
    expect(slugifyBody('API Guidelines (v2)')).toBe('api-guidelines-v2')
    expect(slugifyBody('--Edge Case--')).toBe('edge-case')
    expect(slugifyBody('Café résumé')).toBe('cafe-resume')
    expect(slugifyBody('!!!')).toBe('untitled')
    expect(slugifyBody('')).toBe('untitled')
  })

  it('caps to the requested length', () => {
    expect(slugifyBody('x'.repeat(200), 30).length).toBe(30)
  })
})

describe('suggestSlug', () => {
  it('prefixes by entity type', () => {
    expect(suggestSlug('doc', 'API Guidelines (v2)')).toBe('doc-api-guidelines-v2')
    expect(suggestSlug('skill', 'Deploy Preview')).toBe('sk-deploy-preview')
    expect(suggestSlug('upstream', 'Notion')).toBe('up-notion')
    expect(suggestSlug('gitSource', 'acme-docs')).toBe('repo-acme-docs')
    expect(suggestSlug('team', 'Platform')).toBe('team-platform')
    expect(suggestSlug('product', 'Checkout')).toBe('prod-checkout')
  })

  it('caps the body so the prefixed total fits the entity max', () => {
    const long = 'x'.repeat(300)
    expect(suggestSlug('upstream', long).length).toBeLessThanOrEqual(24)
    expect(suggestSlug('skill', long).length).toBeLessThanOrEqual(64)
    expect(suggestSlug('doc', long).length).toBeLessThanOrEqual(96)
  })

  it('falls back to <prefix>-untitled for empty/symbol names', () => {
    expect(suggestSlug('doc', '!!!')).toBe('doc-untitled')
    expect(suggestSlug('product', '')).toBe('prod-untitled')
  })
})

describe('prefixedSlug', () => {
  const sk = prefixedSlug('skill')
  it('accepts a correctly-prefixed slug', () => {
    expect(sk.safeParse('sk-deploy-preview').success).toBe(true)
  })
  it('rejects a missing/empty prefix body and bad charset', () => {
    expect(sk.safeParse('deploy-preview').success).toBe(false) // no prefix
    expect(sk.safeParse('sk-').success).toBe(false) // empty body
    expect(sk.safeParse('sk-Deploy').success).toBe(false) // uppercase
    expect(sk.safeParse('sk-a--b').success).toBe(false) // double dash
    expect(sk.safeParse('sk-a-').success).toBe(false) // trailing dash
  })
  it('upstream prefix is dash-based and excludes the old underscore form', () => {
    expect(prefixedSlug('upstream').safeParse('up-notion').success).toBe(true)
    expect(prefixedSlug('upstream').safeParse('notion').success).toBe(false)
  })
})

describe('SLUG_PREFIX', () => {
  it('covers every slug-bearing entity', () => {
    expect(Object.keys(SLUG_PREFIX).sort()).toEqual(
      ['doc', 'gitSource', 'product', 'role', 'skill', 'team', 'upstream'].sort()
    )
  })
})
