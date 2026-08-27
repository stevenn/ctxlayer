import { describe, it, expect } from 'vitest'
import { markdownToBlocks } from './markdown-to-blocks'
import { renderBlocksToMarkdown } from '../rag/markdown'

const TABLE = [
  '| Good Constraint | Bad Constraint |',
  '| --- | --- |',
  '| "Follow error handling patterns" | "Write good code" |',
  '| `retry(3)` on network calls | vague advice |'
].join('\n')

describe('markdownToBlocks — pipe tables', () => {
  it('parses a GFM pipe table into a table block (BlockNote 0.51 tableCell shape)', () => {
    const blocks = markdownToBlocks(TABLE)
    expect(blocks).toHaveLength(1)
    const table = blocks[0]!
    expect(table.type).toBe('table')
    const content = table.content as { type: string; rows: Array<{ cells: unknown[] }> }
    expect(content.type).toBe('tableContent')
    // Header + 2 body rows; the separator row is dropped.
    expect(content.rows).toHaveLength(3)
    expect(content.rows[0]!.cells[0]).toEqual({
      type: 'tableCell',
      props: {},
      content: [{ type: 'text', text: 'Good Constraint', styles: {} }]
    })
  })

  it('round-trips a table through renderBlocksToMarkdown unchanged', () => {
    expect(renderBlocksToMarkdown(markdownToBlocks(TABLE))).toBe(TABLE)
  })

  it('parses inline styles inside cells', () => {
    const blocks = markdownToBlocks('| `code` | **bold** |\n| --- | --- |')
    const content = blocks[0]!.content as {
      rows: Array<{ cells: Array<{ content: Array<{ text: string; styles: object }> }> }>
    }
    expect(content.rows[0]!.cells[0]!.content).toEqual([
      { type: 'text', text: 'code', styles: { code: true } }
    ])
    expect(content.rows[0]!.cells[1]!.content).toEqual([
      { type: 'text', text: 'bold', styles: { bold: true } }
    ])
  })

  it('accepts alignment colons in the separator row', () => {
    const blocks = markdownToBlocks('| a | b | c |\n|:---|---:|:---:|\n| 1 | 2 | 3 |')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.type).toBe('table')
  })

  it('parses a header-plus-separator table with no body rows', () => {
    const md = '| a | b |\n| --- | --- |'
    const blocks = markdownToBlocks(md)
    expect(blocks[0]!.type).toBe('table')
    expect((blocks[0]!.content as { rows: unknown[] }).rows).toHaveLength(1)
    expect(renderBlocksToMarkdown(blocks)).toBe(md)
  })

  it('leaves a pipe line without a separator row as a paragraph', () => {
    const blocks = markdownToBlocks('| just some | pipes')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.type).toBe('paragraph')
  })

  it('does not swallow a table into a preceding paragraph (the collapse regression)', () => {
    const blocks = markdownToBlocks(`intro line\n${TABLE}`)
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'table'])
  })

  it('stops the table at a blank line and parses what follows', () => {
    const blocks = markdownToBlocks(`${TABLE}\n\nafter the table`)
    expect(blocks.map((b) => b.type)).toEqual(['table', 'paragraph'])
  })
})
