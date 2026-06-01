import { describe, expect, it } from 'vitest'
import { renderBlocksToMarkdown } from './markdown'

function block(type: string, text: string, extras: object = {}) {
  return {
    type,
    content: text ? [{ type: 'text', text, styles: {} }] : [],
    children: [],
    ...extras
  }
}

describe('renderBlocksToMarkdown', () => {
  it('renders an empty doc as ""', () => {
    expect(renderBlocksToMarkdown([])).toBe('')
  })

  it('renders a paragraph', () => {
    expect(renderBlocksToMarkdown([block('paragraph', 'Hello.')])).toBe('Hello.')
  })

  it('renders headings with the right level (clamped 1..6)', () => {
    const out = renderBlocksToMarkdown([
      block('heading', 'H1', { props: { level: 1 } }),
      block('heading', 'H2', { props: { level: 2 } }),
      block('heading', 'H3', { props: { level: 3 } }),
      block('heading', 'H4', { props: { level: 4 } }),
      block('heading', 'H5', { props: { level: 5 } }),
      block('heading', 'H6', { props: { level: 6 } }),
      block('heading', 'Bad', { props: { level: 99 } })
    ])
    expect(out).toBe('# H1\n\n## H2\n\n### H3\n\n#### H4\n\n##### H5\n\n###### H6\n\n## Bad')
  })

  it('renders inline marks: bold, italic, code, strike', () => {
    const out = renderBlocksToMarkdown([
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'b', styles: { bold: true } },
          { type: 'text', text: 'i', styles: { italic: true } },
          { type: 'text', text: 'c', styles: { code: true } },
          { type: 'text', text: 's', styles: { strike: true } }
        ]
      }
    ])
    expect(out).toBe('**b**' + '*i*' + '`c`' + '~~s~~')
  })

  it('combines bold + italic without doubling backticks for code', () => {
    const out = renderBlocksToMarkdown([
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'x', styles: { bold: true, italic: true } }]
      }
    ])
    expect(out).toBe('***x***')
  })

  it('renders links', () => {
    const out = renderBlocksToMarkdown([
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'see ', styles: {} },
          {
            type: 'link',
            href: 'https://example.com',
            content: [{ type: 'text', text: 'docs', styles: {} }]
          }
        ]
      }
    ])
    expect(out).toBe('see [docs](https://example.com)')
  })

  it('renders bullet, numbered, and check list items with nesting', () => {
    const out = renderBlocksToMarkdown([
      {
        ...block('bulletListItem', 'parent'),
        children: [block('bulletListItem', 'child')]
      },
      block('numberedListItem', 'first'),
      block('checkListItem', 'done', { props: { checked: true } }),
      block('checkListItem', 'todo', { props: { checked: false } })
    ])
    expect(out).toBe('- parent\n  - child\n\n1. first\n\n- [x] done\n\n- [ ] todo')
  })

  it('renders a code block with language fence', () => {
    expect(
      renderBlocksToMarkdown([block('codeBlock', 'echo hi', { props: { language: 'sh' } })])
    ).toBe('```sh\necho hi\n```')
  })

  it('renders a quote prefixing each line', () => {
    expect(
      renderBlocksToMarkdown([
        {
          type: 'quote',
          content: [{ type: 'text', text: 'line1\nline2', styles: {} }]
        }
      ])
    ).toBe('> line1\n> line2')
  })

  it('renders a table with header separator (legacy InlineContent[][] cells)', () => {
    const cell = (t: string) => [{ type: 'text', text: t, styles: {} }]
    const out = renderBlocksToMarkdown([
      {
        type: 'table',
        content: {
          type: 'tableContent',
          rows: [{ cells: [cell('a'), cell('b')] }, { cells: [cell('1'), cell('2')] }]
        }
      }
    ])
    expect(out).toBe('| a | b |\n| --- | --- |\n| 1 | 2 |')
  })

  it('renders a table whose cells are TableCell-wrapped (BlockNote 0.51 new shape)', () => {
    // Regression: this shape used to throw `items.map is not a function`
    // because the cell was an object, not an inline array.
    const tcell = (t: string) => ({
      type: 'tableCell',
      props: {},
      content: [{ type: 'text', text: t, styles: {} }]
    })
    const out = renderBlocksToMarkdown([
      {
        type: 'table',
        content: {
          type: 'tableContent',
          rows: [{ cells: [tcell('a'), tcell('b')] }, { cells: [tcell('1'), tcell('2')] }]
        }
      }
    ])
    expect(out).toBe('| a | b |\n| --- | --- |\n| 1 | 2 |')
  })

  it('handles a malformed cell (object that is neither array nor TableCell) by emitting an empty cell', () => {
    const out = renderBlocksToMarkdown([
      {
        type: 'table',
        content: {
          type: 'tableContent',
          rows: [{ cells: [{ weird: true } as never, [{ type: 'text', text: 'ok', styles: {} }]] }]
        }
      }
    ])
    // Header row: empty first cell, "ok" in the second. No body rows.
    expect(out).toBe('|  | ok |\n| --- | --- |')
  })

  it('degrades unknown blocks to their text content', () => {
    expect(renderBlocksToMarkdown([block('weirdBlock', 'still here')])).toBe('still here')
  })

  it('numbers adjacent numberedListItem blocks sequentially', () => {
    const out = renderBlocksToMarkdown([
      block('numberedListItem', 'one'),
      block('numberedListItem', 'two'),
      block('numberedListItem', 'three')
    ])
    expect(out).toBe('1. one\n\n2. two\n\n3. three')
  })

  it('resets numbered list counter when interrupted by a non-list block', () => {
    const out = renderBlocksToMarkdown([
      block('numberedListItem', 'one'),
      block('numberedListItem', 'two'),
      block('paragraph', 'aside'),
      block('numberedListItem', 'a fresh start')
    ])
    expect(out).toBe('1. one\n\n2. two\n\naside\n\n1. a fresh start')
  })

  it('renders toggleListItem with its children expanded', () => {
    const out = renderBlocksToMarkdown([
      {
        ...block('toggleListItem', 'Pitfalls'),
        children: [block('paragraph', 'inner detail')]
      }
    ])
    expect(out).toBe('- Pitfalls\n  inner detail')
  })

  it('renders image with caption as markdown image syntax', () => {
    const out = renderBlocksToMarkdown([
      {
        type: 'image',
        props: { caption: 'system diagram', name: 'arch.png', url: 'https://x/y.png' }
      }
    ])
    expect(out).toBe('![system diagram](https://x/y.png)')
  })

  it('falls back to name then alt text when image url is missing', () => {
    expect(renderBlocksToMarkdown([{ type: 'image', props: { name: 'arch.png' } }])).toBe(
      'arch.png'
    )
    expect(renderBlocksToMarkdown([{ type: 'image', props: {} }])).toBe('image')
  })

  it('renders audio/video/file as text links so caption + url survive', () => {
    const out = renderBlocksToMarkdown([
      { type: 'audio', props: { caption: 'standup recording', url: 'https://x/a.mp3' } },
      { type: 'video', props: { caption: 'demo', url: 'https://x/v.mp4' } },
      { type: 'file', props: { name: 'spec.pdf', url: 'https://x/spec.pdf' } }
    ])
    expect(out).toBe(
      '[standup recording](https://x/a.mp3)\n\n[demo](https://x/v.mp4)\n\n[spec.pdf](https://x/spec.pdf)'
    )
  })

  it('renders divider and pageBreak as thematic breaks', () => {
    const out = renderBlocksToMarkdown([
      block('paragraph', 'above'),
      { type: 'divider' },
      block('paragraph', 'middle'),
      { type: 'pageBreak' },
      block('paragraph', 'below')
    ])
    expect(out).toBe('above\n\n---\n\nmiddle\n\n---\n\nbelow')
  })
})
