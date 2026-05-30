/**
 * Unit tests for the Yjs → BlockNote-blocks decoder. We construct the
 * `document-store` Y.XmlFragment the way y-prosemirror lays it out
 * (blockGroup > blockContainer > <blockType> with Y.XmlText inline) and
 * assert both the block tree and the markdown it renders to via the
 * shared renderer. End-to-end correctness against a real BlockNote
 * snapshot is verified separately by reading a live doc over MCP.
 */
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { yDocToBlocks, yjsSnapshotToBlocks, COLLAB_FRAGMENT } from './yjs-blocks'
import { renderBlocksToMarkdown } from '../rag/markdown'

function textEl(insert: string, attributes?: Record<string, unknown>): Y.XmlText {
  const t = new Y.XmlText()
  t.insert(0, insert, attributes)
  return t
}

function blockContainer(content: Y.XmlElement, nested?: Y.XmlElement): Y.XmlElement {
  const c = new Y.XmlElement('blockContainer')
  c.insert(0, nested ? [content, nested] : [content])
  return c
}

/** Build a doc whose top-level blocks are the given content elements. */
function buildDoc(containers: Y.XmlElement[]): Y.Doc {
  const doc = new Y.Doc()
  const group = new Y.XmlElement('blockGroup')
  group.insert(0, containers)
  doc.getXmlFragment(COLLAB_FRAGMENT).insert(0, [group])
  return doc
}

function para(...texts: Y.XmlText[]): Y.XmlElement {
  const p = new Y.XmlElement('paragraph')
  p.insert(0, texts)
  return p
}

describe('yDocToBlocks', () => {
  it('extracts a single paragraph (the real-world failure case)', () => {
    const doc = buildDoc([blockContainer(para(textEl('bananas')))])
    const blocks = yDocToBlocks(doc)
    expect(blocks).toEqual([
      { type: 'paragraph', props: {}, content: [{ type: 'text', text: 'bananas', styles: {} }], children: [] }
    ])
    expect(renderBlocksToMarkdown(blocks)).toBe('bananas')
  })

  it('maps heading level + inline styles and a link', () => {
    const heading = new Y.XmlElement('heading')
    heading.setAttribute('level', '2')
    heading.insert(0, [textEl('Practices')])
    const body = para(
      textEl('always add a '),
      textEl('bold', { bold: {} }),
      textEl(' '),
      textEl('quote', { link: { href: 'https://tolkien.test' } })
    )
    const blocks = yDocToBlocks(buildDoc([blockContainer(heading), blockContainer(body)]))

    expect(blocks[0]).toMatchObject({ type: 'heading', props: { level: 2 } })
    const md = renderBlocksToMarkdown(blocks)
    expect(md).toContain('## Practices')
    expect(md).toContain('**bold**')
    expect(md).toContain('[quote](https://tolkien.test)')
  })

  it('handles nested children under a list item', () => {
    const childGroup = new Y.XmlElement('blockGroup')
    childGroup.insert(0, [blockContainer(para(textEl('nested')))])
    const item = new Y.XmlElement('bulletListItem')
    item.insert(0, [textEl('parent')])
    const blocks = yDocToBlocks(buildDoc([blockContainer(item, childGroup)]))

    expect(blocks[0]).toMatchObject({ type: 'bulletListItem' })
    expect((blocks[0] as { children: unknown[] }).children).toHaveLength(1)
    const md = renderBlocksToMarkdown(blocks)
    expect(md).toContain('- parent')
    expect(md).toContain('nested')
  })

  it('round-trips through encodeStateAsUpdate (snapshot bytes)', () => {
    const doc = buildDoc([blockContainer(para(textEl('from bytes')))])
    const bytes = Y.encodeStateAsUpdate(doc)
    expect(renderBlocksToMarkdown(yjsSnapshotToBlocks(bytes))).toBe('from bytes')
  })

  it('returns empty for an empty doc', () => {
    expect(yDocToBlocks(new Y.Doc())).toEqual([])
  })
})
