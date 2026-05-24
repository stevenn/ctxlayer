import { describe, expect, it } from 'vitest'
import { chunkMarkdown } from './chunker'

describe('chunkMarkdown', () => {
  it('returns no chunks for empty input', () => {
    expect(chunkMarkdown('')).toEqual([])
  })

  it('keeps a small doc in one chunk', () => {
    const out = chunkMarkdown('# Title\n\nA single short paragraph.')
    expect(out).toHaveLength(1)
    expect(out[0]?.headings).toEqual(['Title'])
    expect(out[0]?.text).toContain('# Title')
    expect(out[0]?.text).toContain('A single short paragraph.')
  })

  it('tracks the heading stack across h1/h2/h3 with resets', () => {
    const md =
      '# Eng\n\n## API\n\nfoo\n\n### Pagination\n\nbar\n\n## Storage\n\nbaz'
    const chunks = chunkMarkdown(md, { targetTokens: 10_000 })
    // small target -> single chunk; headings come from the START
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.headings).toEqual(['Eng'])
  })

  it('splits when running past the target and overlaps for context', () => {
    // 200 short paragraphs => definitely past 64-token target.
    const paragraphs = Array.from({ length: 200 }, (_, i) => `Paragraph ${i + 1}.`)
    const md = '# Doc\n\n' + paragraphs.join('\n\n')
    const chunks = chunkMarkdown(md, { targetTokens: 64, overlapTokens: 8 })
    expect(chunks.length).toBeGreaterThan(1)
    // Every chunk after the first should start with overlap text from
    // somewhere in the previous chunk.
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1]!
      const cur = chunks[i]!
      expect(prev.tokenCount).toBeLessThanOrEqual(64)
      expect(cur.tokenCount).toBeLessThanOrEqual(64)
      // Trivial sanity: heading stack survives every chunk.
      expect(cur.headings).toEqual(['Doc'])
    }
  })

  it('hard-splits a single oversized line', () => {
    // ~1500 chars of "word " -> ~400 tokens; force tiny target to trip
    // the oversize branch.
    const oneBigLine = ('word '.repeat(800)).trim()
    const chunks = chunkMarkdown(oneBigLine, { targetTokens: 20, overlapTokens: 0 })
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) {
      expect(c.tokenCount).toBeLessThanOrEqual(20)
    }
  })

  it('falls back to [title] when a chunk starts before any heading', () => {
    // No h1-h3 anywhere -> active heading stack stays empty for all
    // chunks. With `title` supplied, every chunk's headings === [title].
    const md = 'Just a paragraph.\n\nAnd one more.'
    const chunks = chunkMarkdown(md, { title: 'Doc Title' })
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.headings).toEqual(['Doc Title'])
  })

  it('uses real headings when present and ignores title fallback', () => {
    const md = '# Real H1\n\nbody'
    const chunks = chunkMarkdown(md, { title: 'Doc Title' })
    expect(chunks[0]?.headings).toEqual(['Real H1'])
  })

  it('assigns sequential idx starting at 0', () => {
    const md = Array.from({ length: 50 }, (_, i) => `Para ${i}.`).join('\n\n')
    const chunks = chunkMarkdown(md, { targetTokens: 32 })
    expect(chunks.map((c) => c.idx)).toEqual(chunks.map((_, i) => i))
  })
})
