import { describe, expect, it } from 'vitest'
import { mangleToolName, unmangleToolName } from './tool-name'

describe('mangleToolName', () => {
  it('joins slug and tool name with __', () => {
    expect(mangleToolName('notion', 'search_pages')).toBe('notion__search_pages')
  })

  it('escapes literal __ in the tool name', () => {
    expect(mangleToolName('weird', 'foo__bar')).toBe('weird__foo_~_bar')
  })
})

describe('unmangleToolName', () => {
  it('splits on first __', () => {
    expect(unmangleToolName('notion__search_pages')).toEqual({
      slug: 'notion',
      toolName: 'search_pages'
    })
  })

  it('round-trips an escaped name', () => {
    const mangled = mangleToolName('weird', 'foo__bar')
    expect(unmangleToolName(mangled)).toEqual({ slug: 'weird', toolName: 'foo__bar' })
  })

  it('returns null for a name without a delimiter', () => {
    expect(unmangleToolName('search_docs')).toBeNull()
    expect(unmangleToolName('__leading')).toBeNull()
    expect(unmangleToolName('trailing__')).toBeNull()
  })
})
