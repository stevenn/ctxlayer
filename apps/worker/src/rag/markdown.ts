/**
 * BlockNote JSON → markdown for embedding/chunking. NOT a perfect
 * round-trip renderer — the goal is to extract semantically meaningful
 * text so embeddings work and so the chunker can find heading
 * boundaries.
 *
 * We deliberately avoid `@blocknote/server-util` because it depends
 * on ProseMirror + a DOM (happy-dom), and workerd does not expose a
 * DOM. Adding the polyfill is brittle and bloats the bundle. The
 * walker below covers BlockNote 0.51's full default schema:
 *
 *   Blocks   : paragraph, heading (H1–H6), bulletListItem,
 *              numberedListItem (sequentially numbered),
 *              checkListItem, toggleListItem (expanded),
 *              codeBlock, quote, table, image, audio, video, file,
 *              divider, pageBreak.
 *   Inline   : bold, italic, code, strike (~~), link. Underline and
 *              colour styles strip to plain text (no markdown
 *              equivalent / cosmetic only).
 *   Unknowns : degrade to their text + child content (never silent).
 *
 * Add a new block type when BlockNote ships one — `markdown.test.ts`
 * is the contract.
 */

// ----- block shape (subset we care about) --------------------------------

interface TextLeaf {
  type: 'text'
  text: string
  styles?: {
    bold?: boolean
    italic?: boolean
    code?: boolean
    strike?: boolean
    underline?: boolean
  }
}
interface LinkLeaf {
  type: 'link'
  href: string
  content: TextLeaf[]
}
type Inline = TextLeaf | LinkLeaf

// BlockNote 0.51 emits one of two shapes for table cells:
//   InlineContent[][]                       (legacy / unwrapped)
//   { type: 'tableCell', content: ... }[]   (new wrapper)
// We accept both — see normaliseCell().
interface TableCell {
  type: 'tableCell'
  props?: Record<string, unknown>
  content?: Inline[]
}
type CellAny = Inline[] | TableCell
interface TableContent {
  type: 'tableContent'
  rows: Array<{ cells: CellAny[] }>
}

interface Block {
  id?: string
  type: string
  props?: Record<string, unknown>
  content?: Inline[] | TableContent
  children?: Block[]
}

export function renderBlocksToMarkdown(blocks: unknown[]): string {
  const out = renderSiblings(blocks as Block[], 0)
  // Collapse runs of >2 blank lines that nested cases can produce.
  return out.join('\n\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * Walk a list of sibling blocks. The wrapper tracks numbered-list
 * position so adjacent `numberedListItem` blocks get sequential
 * counters (`1.`, `2.`, …) instead of the BlockNote-shape default
 * where every item is its own block.
 */
function renderSiblings(blocks: Block[], depth: number): string[] {
  const out: string[] = []
  let numberedPos = 0
  for (const b of blocks) {
    if (b.type === 'numberedListItem') {
      numberedPos += 1
      const md = renderBlock(b, depth, numberedPos)
      if (md) out.push(md)
    } else {
      numberedPos = 0
      const md = renderBlock(b, depth)
      if (md) out.push(md)
    }
  }
  return out
}

function renderBlock(b: Block, depth: number, numberedPos = 1): string {
  switch (b.type) {
    case 'heading': {
      const level = clampHeading(b.props?.['level'])
      return `${'#'.repeat(level)} ${renderInline(asInline(b.content))}`
    }
    case 'paragraph':
      return renderInline(asInline(b.content))
    case 'bulletListItem':
      return renderListItem(b, depth, '-')
    case 'numberedListItem':
      return renderListItem(b, depth, `${numberedPos}.`)
    case 'checkListItem': {
      const checked = b.props?.['checked'] === true
      const marker = checked ? '- [x]' : '- [ ]'
      return renderListItem(b, depth, marker)
    }
    case 'toggleListItem':
      // Toggle is collapsible in the editor; for embedding we always
      // expose both the toggle title and its children so search hits
      // collapsed sections too.
      return renderListItem(b, depth, '-')
    case 'codeBlock': {
      const lang = strProp(b.props, 'language')
      return '```' + lang + '\n' + renderInline(asInline(b.content)) + '\n```'
    }
    case 'quote': {
      const inner = renderInline(asInline(b.content))
      return inner
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n')
    }
    case 'table':
      return renderTable(b.content as TableContent | undefined)
    case 'image':
      return renderImage(b)
    case 'audio':
    case 'video':
    case 'file':
      return renderMediaLink(b)
    case 'divider':
    case 'pageBreak':
      return '---'
    default:
      // Unknown block: best-effort fall back to its text + children so
      // we don't drop content silently.
      return [renderInline(asInline(b.content)), renderChildren(b.children, depth)]
        .filter(Boolean)
        .join('\n')
  }
}

function renderListItem(b: Block, depth: number, marker: string): string {
  const indent = '  '.repeat(depth)
  const head = `${indent}${marker} ${renderInline(asInline(b.content))}`
  const kids = renderChildren(b.children, depth + 1)
  if (!kids) return head
  // Indent non-list-item children (paragraphs, code, quotes, …) to
  // align with the list marker. Nested list items already self-indent
  // via their own `depth`, so we only pad lines that aren't already
  // at least the expected indent.
  const childIndent = '  '.repeat(depth + 1)
  const padded = kids
    .split('\n')
    .map((line) => (line.length === 0 || line.startsWith(childIndent) ? line : childIndent + line))
    .join('\n')
  return `${head}\n${padded}`
}

function renderChildren(children: Block[] | undefined, depth: number): string {
  if (!children || children.length === 0) return ''
  return renderSiblings(children, depth).join('\n')
}

/**
 * Image block → markdown `![alt](url)`. Caption preferred over name
 * for alt text since captions are author-written; name is the file
 * name fallback. Url-less images degrade to bare alt text so the
 * embedder still sees the human-readable label.
 */
function renderImage(b: Block): string {
  const url = strProp(b.props, 'url')
  const alt = strProp(b.props, 'caption') || strProp(b.props, 'name') || 'image'
  return url ? `![${alt}](${url})` : alt
}

/**
 * Audio / video / file → markdown text link. Markdown has no native
 * media syntax, but the surface area we care about (alt text, URL)
 * survives as `[label](url)` which embedders and humans both parse.
 */
function renderMediaLink(b: Block): string {
  const url = strProp(b.props, 'url')
  const label = strProp(b.props, 'caption') || strProp(b.props, 'name') || b.type
  return url ? `[${label}](${url})` : label
}

function strProp(props: Block['props'], key: string): string {
  const v = props?.[key]
  return typeof v === 'string' ? v : ''
}

function renderInline(items: unknown): string {
  // Defensive: a non-array reaching here means we mis-typed an upstream
  // BlockNote shape. Return '' instead of throwing — the queue
  // consumer would otherwise retry-then-drop the whole reindex,
  // which is far worse than skipping one block's text. The walker's
  // top-level catch logs the original payload for debugging.
  if (!Array.isArray(items)) return ''
  return (items as Inline[])
    .map((node) => {
      if (node.type === 'link') {
        const inner = renderInline(node.content)
        return `[${inner}](${node.href})`
      }
      const text = node.text
      const s = node.styles ?? {}
      // Order matters: code wins over bold/italic so we don't wrap the
      // backticks themselves in stars (embedders dislike `**` runs).
      if (s.code) return '`' + text + '`'
      let out = text
      if (s.strike) out = `~~${out}~~`
      if (s.italic) out = `*${out}*`
      if (s.bold) out = `**${out}**`
      // underline has no markdown equivalent — strip the style.
      return out
    })
    .join('')
}

function renderTable(t: TableContent | undefined): string {
  if (!t || !Array.isArray(t.rows) || t.rows.length === 0) return ''
  const [header, ...body] = t.rows
  if (!header || !Array.isArray(header.cells)) return ''
  const headerCells = header.cells.map((c) => renderInline(normaliseCell(c)))
  const separator = headerCells.map(() => '---')
  const bodyRows = body.map(
    (r) =>
      `| ${(Array.isArray(r.cells) ? r.cells : [])
        .map((c) => renderInline(normaliseCell(c)))
        .join(' | ')} |`
  )
  return [`| ${headerCells.join(' | ')} |`, `| ${separator.join(' | ')} |`, ...bodyRows].join('\n')
}

/** Collapse the two BlockNote cell shapes into a flat InlineContent[]. */
function normaliseCell(c: CellAny): Inline[] {
  if (Array.isArray(c)) return c
  if (c && typeof c === 'object' && Array.isArray(c.content)) return c.content
  return []
}

function asInline(content: Block['content']): Inline[] {
  if (!content) return []
  if (Array.isArray(content)) return content
  return [] // tableContent — handled by renderTable directly
}

function clampHeading(level: unknown): 1 | 2 | 3 | 4 | 5 | 6 {
  if (level === 1 || level === 2 || level === 3 || level === 4 || level === 5 || level === 6) {
    return level
  }
  return 2
}
