import { describe, it, expect } from 'vitest'
import { bestSnippet } from './snippet'

describe('bestSnippet', () => {
  it('returns short text unchanged', () => {
    expect(bestSnippet('a short body', ['body'], 400)).toBe('a short body')
  })

  it('centres the window on the matched term, with ellipses', () => {
    const filler = 'lorem ipsum dolor sit amet '.repeat(40) // ~1080 chars
    const text = `${filler}the WIDGET configuration lives here ${filler}`
    const snip = bestSnippet(text, ['widget'], 120)
    expect(snip.toLowerCase()).toContain('widget')
    expect(snip.startsWith('…')).toBe(true)
    expect(snip.endsWith('…')).toBe(true)
    // Window is roughly bounded by maxLen (+ ellipses + word-snap slack).
    expect(snip.length).toBeLessThan(160)
  })

  it('falls back to the head when no term overlaps (semantic-only match)', () => {
    const text = 'alpha beta gamma '.repeat(60) // long, no query terms present
    const snip = bestSnippet(text, ['nonexistent'], 100)
    expect(snip.startsWith('alpha beta')).toBe(true)
    expect(snip.endsWith('…')).toBe(true)
    expect(snip.length).toBeLessThanOrEqual(101)
  })

  it('falls back to the head when there are no terms at all', () => {
    const text = 'x'.repeat(1000)
    const snip = bestSnippet(text, [], 50)
    expect(snip.endsWith('…')).toBe(true)
    expect(snip.length).toBeLessThanOrEqual(51)
  })

  it('prefers the densest cluster of terms', () => {
    const filler = 'noise '.repeat(100)
    // one lone "api" early, then a dense cluster late
    const text = `start api ${filler} the api token and api scope and api key section ${filler} end`
    const snip = bestSnippet(text, ['api', 'token', 'scope', 'key'], 120)
    expect(snip).toContain('token')
    expect(snip).toContain('scope')
  })
})
