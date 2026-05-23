import { describe, expect, it } from 'vitest'
import { slugify } from './docs'

describe('slugify', () => {
  it('lowercases and dasherises typical titles', () => {
    expect(slugify('Hello World')).toBe('hello-world')
    expect(slugify('API Guidelines (v2)')).toBe('api-guidelines-v2')
  })

  it('strips leading and trailing dashes', () => {
    expect(slugify('--Edge Case--')).toBe('edge-case')
  })

  it('collapses runs of separators', () => {
    expect(slugify('multiple   spaces / and \\ slashes')).toBe('multiple-spaces-and-slashes')
  })

  it('handles non-ascii by stripping after NFKD', () => {
    expect(slugify('Café résumé')).toBe('cafe-resume')
  })

  it('returns "untitled" for empty after stripping', () => {
    expect(slugify('!!!')).toBe('untitled')
    expect(slugify('')).toBe('untitled')
  })

  it('truncates to 90 chars', () => {
    const long = 'a'.repeat(200)
    expect(slugify(long).length).toBe(90)
  })
})
