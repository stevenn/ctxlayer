import { describe, expect, it } from 'vitest'
import { collapseSlugPrefix, mangleToolName, unmangleToolName } from './tool-name'

describe('mangleToolName', () => {
  it('joins slug and tool name with __', () => {
    expect(mangleToolName('linear', 'list_issues')).toBe('linear__list_issues')
  })

  it('escapes literal __ in the tool name', () => {
    expect(mangleToolName('weird', 'foo__bar')).toBe('weird__foo_~_bar')
  })

  it('collapses a redundant slug-prefix (hyphen separator)', () => {
    expect(mangleToolName('notion', 'notion-search')).toBe('notion__search')
    expect(mangleToolName('notion', 'notion-fetch')).toBe('notion__fetch')
  })

  it('collapses a redundant slug-prefix (underscore separator)', () => {
    expect(mangleToolName('github', 'github_create_issue')).toBe('github__create_issue')
  })

  it('is case-insensitive on the slug match', () => {
    expect(mangleToolName('notion', 'Notion-Search')).toBe('notion__Search')
  })

  it("doesn't strip when the prefix is the whole tool name", () => {
    // Leaving "notion__" would be invalid — keep the original.
    expect(mangleToolName('notion', 'notion')).toBe('notion__notion')
  })

  it("doesn't strip a partial-word match", () => {
    // 'notion' is not followed by '-' or '_', so leave it.
    expect(mangleToolName('notion', 'notionography')).toBe('notion__notionography')
  })
})

describe('unmangleToolName', () => {
  it('splits on first __', () => {
    expect(unmangleToolName('linear__list_issues')).toEqual({
      slug: 'linear',
      toolName: 'list_issues'
    })
  })

  it('round-trips an escaped name when no slug-prefix collapse applies', () => {
    const mangled = mangleToolName('weird', 'foo__bar')
    expect(unmangleToolName(mangled)).toEqual({ slug: 'weird', toolName: 'foo__bar' })
  })

  it('returns the collapsed (display) tool name, not the original', () => {
    // After slug-prefix collapse, unmangle CANNOT recover the original
    // 'notion-search' — dispatchers must use `upstream_tools.tool_name`
    // from D1 instead. This test pins that contract.
    const mangled = mangleToolName('notion', 'notion-search')
    expect(unmangleToolName(mangled)).toEqual({ slug: 'notion', toolName: 'search' })
  })

  it('returns null for a name without a delimiter', () => {
    expect(unmangleToolName('search_docs')).toBeNull()
    expect(unmangleToolName('__leading')).toBeNull()
    expect(unmangleToolName('trailing__')).toBeNull()
  })
})

describe('collapseSlugPrefix', () => {
  it('passes through when there is no shared prefix', () => {
    expect(collapseSlugPrefix('notion', 'search')).toBe('search')
  })

  it('strips slug + hyphen', () => {
    expect(collapseSlugPrefix('notion', 'notion-search')).toBe('search')
  })

  it('strips slug + underscore', () => {
    expect(collapseSlugPrefix('github', 'github_create')).toBe('create')
  })

  it('leaves alone when tool name equals slug', () => {
    expect(collapseSlugPrefix('notion', 'notion')).toBe('notion')
  })
})
