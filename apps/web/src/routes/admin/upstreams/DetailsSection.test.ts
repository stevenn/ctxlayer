import { describe, expect, it } from 'vitest'
import { badHeaderLines, extraHeadersToText, textToExtraHeaders } from './DetailsSection'

describe('extra header parsing', () => {
  it('round-trips a header map through the textarea format', () => {
    const headers = { 'CF-Access-Client-Id': 'abc123.access', 'X-Tenant': 'yuki' }
    expect(textToExtraHeaders(extraHeadersToText(headers))).toEqual(headers)
  })

  it('splits on the first colon so a value can contain one', () => {
    expect(textToExtraHeaders('X-Origin: https://pdd.yukitools.dev/public/mcp')).toEqual({
      'X-Origin': 'https://pdd.yukitools.dev/public/mcp'
    })
  })

  it('ignores blank lines and surrounding whitespace', () => {
    expect(textToExtraHeaders('\n  X-A:   1  \n\n')).toEqual({ 'X-A': '1' })
  })

  it('is undefined when empty, so the field is omitted from the wire', () => {
    expect(textToExtraHeaders('')).toBeUndefined()
    expect(textToExtraHeaders('   \n  ')).toBeUndefined()
    expect(extraHeadersToText(undefined)).toBe('')
  })

  it('accepts an empty value', () => {
    expect(textToExtraHeaders('X-Empty:')).toEqual({ 'X-Empty': '' })
  })

  it('reports lines that carry no pair rather than dropping them silently', () => {
    expect(badHeaderLines('X-Good: 1\ngarbage\n: novalue\n')).toEqual(['garbage', ': novalue'])
    expect(badHeaderLines('X-Good: 1')).toEqual([])
    // A malformed line contributes nothing to the parsed map.
    expect(textToExtraHeaders('X-Good: 1\ngarbage')).toEqual({ 'X-Good': '1' })
  })
})
