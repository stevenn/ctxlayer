import { describe, expect, it } from 'vitest'
import { classifyHref, conceptPath, scanMarkdownLinkHrefs } from '@ctxlayer/shared'

describe('conceptPath', () => {
  it('builds /folder/slug.md', () => {
    expect(conceptPath('/specs/api', 'auth-guide')).toBe('/specs/api/auth-guide.md')
  })
  it('roots a folderless doc', () => {
    expect(conceptPath(null, 'auth-guide')).toBe('/auth-guide.md')
    expect(conceptPath('', 'auth-guide')).toBe('/auth-guide.md')
  })
})

describe('classifyHref', () => {
  it('treats external URLs / mailto / anchors as non-doc links', () => {
    expect(classifyHref('https://example.com/x')).toBeNull()
    expect(classifyHref('http://example.com')).toBeNull()
    expect(classifyHref('//cdn.example.com/x')).toBeNull()
    expect(classifyHref('mailto:a@b.com')).toBeNull()
    expect(classifyHref('#section')).toBeNull()
    expect(classifyHref('?section=x')).toBeNull()
    expect(classifyHref('/app/admin/users')).toBeNull() // not a .md path
  })
  it('resolves a legacy /app/docs/{id} link by id', () => {
    expect(classifyHref('/app/docs/abc123')).toEqual({ kind: 'id', id: 'abc123' })
  })
  it('resolves OKF concept paths (absolute / relative) by basename slug', () => {
    expect(classifyHref('/specs/api/auth.md')).toEqual({ kind: 'slug', slug: 'auth' })
    expect(classifyHref('./auth.md')).toEqual({ kind: 'slug', slug: 'auth' })
    expect(classifyHref('../x/auth.md')).toEqual({ kind: 'slug', slug: 'auth' })
    expect(classifyHref('/specs/api/auth.md?v=1#h')).toEqual({ kind: 'slug', slug: 'auth' })
  })
})

describe('scanMarkdownLinkHrefs', () => {
  it('extracts link hrefs and skips images', () => {
    const md = 'see [a](/x/a.md) and [b](https://e.com) ![img](/p.png) and [c](./c.md "t")'
    expect(scanMarkdownLinkHrefs(md)).toEqual(['/x/a.md', 'https://e.com', './c.md'])
  })
})
