/**
 * Tiny markdown → BlockNote-blocks converter, used to turn the
 * `body` field returned by `claude -p` into something the SPA editor
 * + MCP rendering pipeline can round-trip.
 *
 * Intentionally minimal: handles paragraphs, ATX headings (#…######),
 * bullet lists (`-` / `*`), numbered lists (`1.` etc), and fenced
 * code blocks. Anything else collapses to a paragraph. The operator
 * polishes in the SPA editor before publishing — high-fidelity
 * markdown parsing is out of scope for the CLI shim.
 */

interface TextLeaf {
  type: 'text'
  text: string
  styles: Record<string, never>
}

interface Block {
  type: string
  props?: Record<string, unknown>
  content: TextLeaf[]
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
        content: [{ type: 'text', text: headingMatch[2]!, styles: {} }]
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
          content: [{ type: 'text', text: item, styles: {} }]
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
          content: [{ type: 'text', text: item, styles: {} }]
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
      content: [{ type: 'text', text: buf.join(' ').trim(), styles: {} }]
    })
  }
  return out
}
