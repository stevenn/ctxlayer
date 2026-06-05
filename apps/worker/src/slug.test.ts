import { describe, it, expect } from 'vitest'
import { SLUG_PREFIX, UpstreamSlug, prefixedSlug, slugifyBody, suggestSlug } from '@ctxlayer/shared'

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

describe('UpstreamSlug (read shape) accepts created slugs', () => {
  it('accepts the dash-bearing up- slugs the create shape produces', () => {
    // Regression: the read regex forbade dashes, so any up-<body> upstream
    // (the prefix convention) failed AdminUpstreamRow parse and broke the
    // admin list with "unexpected response shape". Create-shape output MUST
    // satisfy the read shape.
    for (const s of ['up-notion', 'up-yuki-ia-mcp', suggestSlug('upstream', 'Yuki IA MCP')]) {
      expect(prefixedSlug('upstream').safeParse(s).success).toBe(true)
      expect(UpstreamSlug.safeParse(s).success).toBe(true)
    }
    // grandfathered (pre-prefix) slugs still validate on read
    expect(UpstreamSlug.safeParse('driver').success).toBe(true)
  })
})

describe('SLUG_PREFIX', () => {
  it('covers every slug-bearing entity', () => {
    expect(Object.keys(SLUG_PREFIX).sort()).toEqual(
      ['doc', 'gitSource', 'product', 'role', 'skill', 'team', 'upstream'].sort()
    )
  })
})
