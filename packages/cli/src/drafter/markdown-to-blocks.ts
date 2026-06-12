/**
 * Tiny markdown → BlockNote-blocks converter, used to turn the
 * `body` field returned by `claude -p` into something the SPA editor
 * + MCP rendering pipeline can round-trip.
 *
 * Handles at block level: paragraphs, ATX headings (#…######), bullet
 * lists (`-` / `*`), numbered lists (`1.`), fenced code blocks
 * (```...```). Inline within a block: backtick-code, **bold**, *italic*,
 * _italic_, [text](url).
 *
 * Goal is **round-trip fidelity** with the worker's renderBlocksToMarkdown
 * (apps/worker/src/rag/markdown.ts): the markdown we emit from blocks
 * we built should equal (or near-equal) the source markdown the model
 * produced. So we mirror the inline styles + link shapes that renderer
 * already knows how to serialise — `styles.{bold,italic,code}` and a
 * `link` leaf shape — and avoid any inline construct it can't emit.
 *
 * Out of scope: blockquotes, tables, images, HTML, nested lists,
 * setext headings, hard breaks, escapes. The operator can polish in
 * the SPA editor before publishing.
 */

interface TextLeaf {
  type: 'text'
  text: string
  styles: {
    bold?: boolean
    italic?: boolean
    code?: boolean
  }
}

interface LinkLeaf {
  type: 'link'
  href: string
  content: TextLeaf[]
}

type Inline = TextLeaf | LinkLeaf

interface Block {
  type: string
  props?: Record<string, unknown>
  content: Inline[]
}

export function markdownToBlocks(md: string): Block[] {
  const out: Block[] = []
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  let i = 0

  while (i < lines.length) {
    const line = lines[i] ?? ''

    if (line.trim() === '') {
      i++
      continue
    }

    // Fenced code block: ```lang ... ```
    const fenceMatch = line.match(/^```(\w*)\s*$/)
    if (fenceMatch) {
      const lang = fenceMatch[1] ?? ''
      const buf: string[] = []
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i] ?? '')) {
        buf.push(lines[i] ?? '')
        i++
      }
      if (i < lines.length) i++ // consume closing fence
      out.push({
        type: 'codeBlock',
        props: { language: lang || 'text' },
        // Code blocks are literal — never run through the inline parser.
        content: [{ type: 'text', text: buf.join('\n'), styles: {} }]
      })
      continue
    }

    // ATX heading
    const headingMatch = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/)
    if (headingMatch) {
      out.push({
        type: 'heading',
        props: { level: headingMatch[1]!.length },
        content: parseInline(headingMatch[2]!)
      })
      i++
      continue
    }

    // Bullet list (consume contiguous lines starting with - or *)
    if (/^[-*]\s+/.test(line)) {
      while (i < lines.length && /^[-*]\s+/.test(lines[i] ?? '')) {
        const item = (lines[i] ?? '').replace(/^[-*]\s+/, '')
        out.push({
          type: 'bulletListItem',
          content: parseInline(item)
        })
        i++
      }
      continue
    }

    // Numbered list
    if (/^\d+\.\s+/.test(line)) {
      while (i < lines.length && /^\d+\.\s+/.test(lines[i] ?? '')) {
        const item = (lines[i] ?? '').replace(/^\d+\.\s+/, '')
        out.push({
          type: 'numberedListItem',
          content: parseInline(item)
        })
        i++
      }
      continue
    }

    // Paragraph: greedy until blank line or block-starter
    const buf: string[] = [line]
    i++
    while (i < lines.length) {
      const l = lines[i] ?? ''
      if (
        l.trim() === '' ||
        /^#{1,6}\s+/.test(l) ||
        /^[-*]\s+/.test(l) ||
        /^\d+\.\s+/.test(l) ||
        /^```/.test(l)
      ) {
        break
      }
      buf.push(l)
      i++
    }
    out.push({
      type: 'paragraph',
      content: parseInline(buf.join(' ').trim())
    })
  }
  return out
}

// ----- inline parser ----------------------------------------------------

/**
 * Tokenise a single line of inline markdown into the leaf shape the
 * BlockNote renderer in apps/worker/src/rag/markdown.ts knows how to
 * emit back: `{type:'text', text, styles:{...}}` and `{type:'link',
 * href, content:[...]}`.
 *
 * Construct precedence (left-to-right, longest-match-first per offset):
 *   1. Inline code  `code`
 *   2. Bold         **text**
 *   3. Italic       *text* or _text_
 *   4. Link         [text](url)
 *   5. Plain text   anything else
 *
 * No nesting. The pre-styled segments stay flat — sufficient for
 * round-tripping the formats most operator-authored skills use.
 */
function parseInline(text: string): Inline[] {
  const out: Inline[] = []
  let buf = ''
  let i = 0

  const flushBuf = () => {
    if (buf.length > 0) {
      out.push({ type: 'text', text: buf, styles: {} })
      buf = ''
    }
  }

  while (i < text.length) {
    const ch = text[i]

    // 1. Inline code: `…`
    if (ch === '`') {
      const end = text.indexOf('`', i + 1)
      if (end > i) {
        flushBuf()
        out.push({
          type: 'text',
          text: text.slice(i + 1, end),
          styles: { code: true }
        })
        i = end + 1
        continue
      }
    }

    // 2. Bold: **…**
    if (ch === '*' && text[i + 1] === '*') {
      const end = text.indexOf('**', i + 2)
      if (end > i + 1) {
        const inner = text.slice(i + 2, end)
        // Avoid empty / whitespace-only matches that aren't real markdown.
        if (inner.trim()) {
          flushBuf()
          out.push({
            type: 'text',
            text: inner,
            styles: { bold: true }
          })
          i = end + 2
          continue
        }
      }
    }

    // 3. Italic: *…* or _…_ (single-char delimiters)
    if (ch === '*' || ch === '_') {
      const delim = ch
      // Require word-boundary-ish: don't match `_` inside identifiers.
      // For `*`, also skip when preceded by another `*` (handled by bold).
      const prev = i > 0 ? text[i - 1] : ' '
      if (
        prev !== delim &&
        (delim === '*' || !/\w/.test(prev ?? ' ')) &&
        text[i + 1] !== delim &&
        text[i + 1] !== ' '
      ) {
        const end = findInlineEnd(text, i + 1, delim)
        if (end > i + 1) {
          const inner = text.slice(i + 1, end)
          if (inner.trim()) {
            flushBuf()
            out.push({
              type: 'text',
              text: inner,
              styles: { italic: true }
            })
            i = end + 1
            continue
          }
        }
      }
    }

    // 4. Link: [text](url)
    if (ch === '[') {
      const close = text.indexOf(']', i + 1)
      if (close > i && text[close + 1] === '(') {
        const urlEnd = text.indexOf(')', close + 2)
        if (urlEnd > close + 1) {
          flushBuf()
          out.push({
            type: 'link',
            href: text.slice(close + 2, urlEnd),
            content: [{ type: 'text', text: text.slice(i + 1, close), styles: {} }]
          })
          i = urlEnd + 1
          continue
        }
      }
    }

    // 5. Plain
    buf += ch
    i++
  }
  flushBuf()
  if (out.length === 0) out.push({ type: 'text', text: '', styles: {} })
  return out
}

/**
 * Find the matching closing delimiter for italic (`*` or `_`). Required
 * because the opening test already enforced word-boundary semantics on
 * the LEADING side; we want the closer to satisfy the symmetric rule:
 * the char right after the close must not be a word char (so we don't
 * partially-match inside an identifier).
 */
function findInlineEnd(text: string, from: number, delim: string): number {
  let pos = from
  while (pos < text.length) {
    const idx = text.indexOf(delim, pos)
    if (idx < 0) return -1
    const after = idx + 1 < text.length ? text[idx + 1] : ' '
    if (delim === '_' && after && /\w/.test(after)) {
      pos = idx + 1
      continue
    }
    if (delim === '*' && after === '*') {
      // Probably bold's opening **; skip past.
      pos = idx + 2
      continue
    }
    return idx
  }
  return -1
}
