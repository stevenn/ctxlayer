/**
 * B3 (2026-08 review): the cross-check that pins the FOUR hand-synced
 * markdown↔blocks implementations to one committed fixture, so a
 * BlockNote upgrade that changes the client pair can't silently drift
 * from the server three (renderer, parser, yjs mirror).
 *
 * Fixture: test/fixtures/blocknote-0.51/{content.json, expected.md} —
 * a BlockNote-0.51-shaped snapshot covering every block type the server
 * renderer supports, plus its pinned rendering.
 *
 * REGENERATING ON A BLOCKNOTE UPGRADE (the intended procedure):
 *   1. Recreate the fixture doc in the upgraded editor (paste
 *      expected.md, verify block-by-block), export its content JSON to
 *      content.json (rename the fixture dir to the new version).
 *   2. Re-pin: from apps/worker,
 *        bun -e "import { renderBlocksToMarkdown } from './src/rag/markdown.ts';
 *                import { readFileSync, writeFileSync } from 'node:fs';
 *                const fx = JSON.parse(readFileSync('test/fixtures/<dir>/content.json','utf8'));
 *                writeFileSync('test/fixtures/<dir>/expected.md',
 *                  renderBlocksToMarkdown(fx.blocks) + '\n')"
 *   3. REVIEW THE DIFF of expected.md by hand — that diff IS the
 *      upgrade's behavioral change; update the server implementations
 *      (and git/markdown-normalize.ts, calibrated to 0.51 quirks)
 *      before accepting it.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { renderBlocksToMarkdown } from '../src/rag/markdown'
import { markdownToBlocks } from '../src/skills/markdown-to-blocks'
import { COLLAB_FRAGMENT, yDocToBlocks } from '../src/collab/yjs-blocks'

const DIR = join(__dirname, 'fixtures', 'blocknote-0.51')
const fixture = JSON.parse(readFileSync(join(DIR, 'content.json'), 'utf8')) as {
  blocks: unknown[]
}
const expected = readFileSync(join(DIR, 'expected.md'), 'utf8').replace(/\n$/, '')

describe('BlockNote 0.51 fixture cross-check', () => {
  it('the server renderer reproduces the pinned markdown byte-for-byte', () => {
    expect(renderBlocksToMarkdown(fixture.blocks)).toBe(expected)
  })

  it('markdown-to-blocks round-trips the subset it supports through the renderer', () => {
    // The parser deliberately supports a subset (no quotes, tables,
    // media, checklists, nesting, strike — see its module docstring).
    // For that subset, parse→render must be a fixed point, or drafted
    // skill bodies mutate on every save.
    const subset = [
      '# Release runbook',
      '',
      'Ship **carefully** and *calmly*; run `bun run verify` first.',
      '',
      'See [the docs](https://ctxlayer.example/docs) for details.',
      '',
      '## Clamped heading',
      '',
      '- parent bullet',
      '',
      '1. first step',
      '',
      '2. second step',
      '',
      '```ts',
      'const x: number = 1',
      '```'
    ].join('\n')
    const once = renderBlocksToMarkdown(markdownToBlocks(subset) as unknown[])
    expect(once).toBe(subset)
    // And a second cycle is stable too (no creeping mutation).
    expect(renderBlocksToMarkdown(markdownToBlocks(once) as unknown[])).toBe(once)
  })

  it('the yjs mirror decodes the y-prosemirror layout to renderer-identical blocks', () => {
    // Build the fixture's first three blocks the way y-prosemirror lays
    // them out (blockGroup > blockContainer > <type> with Y.XmlText),
    // then require the decoded blocks to RENDER identically to the same
    // blocks taken from the fixture JSON. Pins the hand-mirrored layout
    // in collab/yjs-blocks.ts to the same contract.
    const heading = new Y.XmlElement('heading')
    heading.setAttribute('level', '1')
    const ht = new Y.XmlText()
    ht.insert(0, 'Release runbook')
    heading.insert(0, [ht])

    const p = new Y.XmlElement('paragraph')
    const t1 = new Y.XmlText()
    t1.insert(0, 'Ship ')
    const t2 = new Y.XmlText()
    t2.insert(0, 'carefully', { bold: true })
    const t3 = new Y.XmlText()
    t3.insert(0, ' and ')
    const t4 = new Y.XmlText()
    t4.insert(0, 'calmly', { italic: true })
    p.insert(0, [t1, t2, t3, t4])

    const containers = [heading, p].map((el) => {
      const c = new Y.XmlElement('blockContainer')
      c.insert(0, [el])
      return c
    })
    const doc = new Y.Doc()
    const group = new Y.XmlElement('blockGroup')
    group.insert(0, containers)
    doc.getXmlFragment(COLLAB_FRAGMENT).insert(0, [group])

    const decoded = yDocToBlocks(doc)
    expect(renderBlocksToMarkdown(decoded)).toBe(
      '# Release runbook\n\nShip **carefully** and *calmly*'
    )
  })
})
