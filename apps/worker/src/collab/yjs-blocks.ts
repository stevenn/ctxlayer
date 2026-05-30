/**
 * Yjs (BlockNote collab) → BlockNote JSON blocks, using only `yjs`.
 *
 * BlockNote stores the collaborative document in a Y.XmlFragment named
 * `document-store` (see COLLAB_FRAGMENT in the SPA editor), encoded by
 * y-prosemirror. The structure mirrors BlockNote's ProseMirror schema:
 *
 *   document-store (Y.XmlFragment)
 *     blockGroup
 *       blockContainer            (one per block; attrs: id, …)
 *         <blockType>             (paragraph | heading | bulletListItem
 *                                  | numberedListItem | checkListItem |
 *                                  quote | codeBlock | …) — inline content
 *                                  lives here as Y.XmlText
 *         blockGroup?             (nested children, recursed)
 *
 * We walk that tree and emit the same BlockNote JSON shape that
 * `rag/markdown.ts#renderBlocksToMarkdown` already consumes, so the
 * materialised snapshot, MCP `get_doc`, and search reindex all share one
 * renderer. We deliberately do NOT pull in `@blocknote/server-util`
 * (ProseMirror + a DOM, absent in workerd) — same call as markdown.ts.
 *
 * Forgiving by design: unknown block node names pass through with their
 * extracted text (never silently dropped), and a structure we don't
 * recognise still yields every Y.XmlText as a paragraph, so we never
 * return empty when the Y.Doc has content.
 */

import * as Y from 'yjs'

export const COLLAB_FRAGMENT = 'document-store'

interface TextLeaf {
  type: 'text'
  text: string
  styles: Record<string, boolean>
}
interface LinkLeaf {
  type: 'link'
  href: string
  content: TextLeaf[]
}
type Inline = TextLeaf | LinkLeaf

interface Block {
  type: string
  props: Record<string, unknown>
  content: Inline[]
  children: Block[]
}

/** Decode a `Y.encodeStateAsUpdate` snapshot into BlockNote JSON blocks. */
export function yjsSnapshotToBlocks(bytes: Uint8Array): Block[] {
  const doc = new Y.Doc()
  try {
    Y.applyUpdate(doc, bytes)
    return yDocToBlocks(doc)
  } finally {
    doc.destroy()
  }
}

/** Decode a live Y.Doc (the DocRoomDO holds one) into BlockNote blocks. */
export function yDocToBlocks(doc: Y.Doc): Block[] {
  return containersOf(doc.getXmlFragment(COLLAB_FRAGMENT)).map(containerToBlock)
}

// ----- walkers -----------------------------------------------------------

function childElements(node: Y.XmlFragment | Y.XmlElement): Array<Y.XmlElement | Y.XmlText> {
  return node.toArray() as Array<Y.XmlElement | Y.XmlText>
}

/**
 * Block-level children of a node: blockContainers, descending through
 * blockGroup wrappers (the doc fragment's only child is a blockGroup).
 */
function containersOf(node: Y.XmlFragment | Y.XmlElement): Y.XmlElement[] {
  const out: Y.XmlElement[] = []
  for (const child of childElements(node)) {
    if (!(child instanceof Y.XmlElement)) continue
    if (child.nodeName === 'blockContainer') out.push(child)
    else if (child.nodeName === 'blockGroup') out.push(...containersOf(child))
  }
  return out
}

function containerToBlock(container: Y.XmlElement): Block {
  let contentEl: Y.XmlElement | null = null
  let nested: Y.XmlElement | null = null
  for (const child of childElements(container)) {
    if (!(child instanceof Y.XmlElement)) continue
    if (child.nodeName === 'blockGroup') nested = child
    else if (!contentEl) contentEl = child
  }

  const type = contentEl?.nodeName ?? 'paragraph'
  return {
    type,
    props: contentEl ? coerceProps(contentEl.getAttributes()) : {},
    content: contentEl ? inlineOf(contentEl) : [],
    children: nested ? containersOf(nested).map(containerToBlock) : []
  }
}

function inlineOf(el: Y.XmlElement): Inline[] {
  const out: Inline[] = []
  for (const child of childElements(el)) {
    if (child instanceof Y.XmlText) out.push(...deltaToInline(child))
    else if (child instanceof Y.XmlElement) out.push(...inlineOf(child)) // inline wrapper
  }
  return out
}

interface DeltaOp {
  insert?: unknown
  attributes?: Record<string, unknown>
}

function deltaToInline(text: Y.XmlText): Inline[] {
  const ops = text.toDelta() as DeltaOp[]
  const out: Inline[] = []
  for (const op of ops) {
    if (typeof op.insert !== 'string' || op.insert.length === 0) continue
    const attrs = op.attributes ?? {}
    const leaf: TextLeaf = { type: 'text', text: op.insert, styles: stylesFrom(attrs) }
    const href = linkHref(attrs)
    if (href) out.push({ type: 'link', href, content: [leaf] })
    else out.push(leaf)
  }
  return out
}

// ----- attribute mapping -------------------------------------------------

const STYLE_KEYS: Record<string, string> = {
  bold: 'bold',
  italic: 'italic',
  code: 'code',
  underline: 'underline',
  strike: 'strike',
  strikethrough: 'strike'
}

function stylesFrom(attrs: Record<string, unknown>): Record<string, boolean> {
  const styles: Record<string, boolean> = {}
  for (const key of Object.keys(attrs)) {
    const mapped = STYLE_KEYS[key]
    if (mapped) styles[mapped] = true
  }
  return styles
}

function linkHref(attrs: Record<string, unknown>): string | null {
  const link = attrs['link']
  if (link && typeof link === 'object') {
    const href = (link as Record<string, unknown>)['href']
    if (typeof href === 'string') return href
  }
  if (typeof attrs['href'] === 'string') return attrs['href'] as string
  return null
}

/**
 * y-prosemirror stores PM node attributes as XML attributes (strings).
 * Coerce the few the markdown renderer reads: `level` (heading) and
 * `checked` (checkListItem); everything else passes through verbatim.
 */
function coerceProps(attrs: Record<string, unknown>): Record<string, unknown> {
  const props: Record<string, unknown> = { ...attrs }
  if ('level' in props) {
    const n = Number(props['level'])
    if (Number.isFinite(n)) props['level'] = n
  }
  if ('checked' in props) {
    props['checked'] = props['checked'] === true || props['checked'] === 'true'
  }
  return props
}
