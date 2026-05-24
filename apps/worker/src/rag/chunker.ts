/**
 * Heading-aware markdown chunker. Produces ~512-token chunks with
 * 64-token overlap, using js-tiktoken's cl100k_base encoder so the
 * counts match what M6 will use against the same encoding.
 *
 * Strategy:
 *   1. Walk lines. Track the current heading stack (h1/h2/h3) so the
 *      chunk metadata can carry semantic context for retrieval.
 *   2. Greedily pack lines into a chunk until adding the next line
 *      would exceed `targetTokens`. Finalize, then start a new chunk
 *      that begins with `overlapTokens` of context from the tail of
 *      the previous chunk plus the active heading line(s).
 *   3. If a single line is itself longer than `targetTokens` (oversize
 *      code block, very long paragraph) — hard-split it at token
 *      boundaries. Embedding quality on a half-cut paragraph beats
 *      shipping an oversize chunk that the embedder will truncate
 *      silently.
 *
 * The encoder is loaded once per isolate; subsequent chunker calls
 * reuse it (cl100k_base vocab is ~1MB to deserialise).
 */

import { getEncoding, type Tiktoken } from 'js-tiktoken'

export interface Chunk {
  idx: number
  text: string
  /** Heading hierarchy active at the chunk's start, h1 first. */
  headings: string[]
  tokenCount: number
}

export interface ChunkerOptions {
  targetTokens?: number
  overlapTokens?: number
  /** When a chunk starts before any h1-h3 has appeared, headings is
   *  normally `[]`. If `title` is supplied, those chunks carry
   *  `[title]` instead so downstream display + future
   *  context-prepending RAG strategies have something to show. */
  title?: string
}

const DEFAULTS: Required<Omit<ChunkerOptions, 'title'>> = {
  targetTokens: 512,
  overlapTokens: 64
}

let cachedEncoder: Tiktoken | null = null
function encoder(): Tiktoken {
  if (!cachedEncoder) cachedEncoder = getEncoding('cl100k_base')
  return cachedEncoder
}

export function chunkMarkdown(md: string, opts: ChunkerOptions = {}): Chunk[] {
  const { targetTokens, overlapTokens } = { ...DEFAULTS, ...opts }
  const title = opts.title?.trim() ?? ''
  const enc = encoder()
  const lines = md.split('\n')
  const chunks: Chunk[] = []

  // Heading stack: index 0 = h1, 1 = h2, 2 = h3. Slots are reset when
  // a higher-or-equal heading appears (h2 resets h3, etc).
  const stack: (string | null)[] = [null, null, null]

  let buf: string[] = []
  let bufTokens = 0
  let chunkHeadings: string[] = title ? [title] : []

  function flush() {
    if (buf.length === 0) return
    const text = buf.join('\n').trim()
    if (!text) return
    chunks.push({
      idx: chunks.length,
      text,
      headings: chunkHeadings,
      tokenCount: bufTokens
    })
    buf = []
    bufTokens = 0
  }

  function activeHeadings(): string[] {
    const active = stack.filter((s): s is string => !!s)
    if (active.length > 0) return active
    return title ? [title] : []
  }

  function startNewBufferWithOverlap() {
    // Take the last `overlapTokens` from the just-finalised chunk as
    // a prefix for the next, then capture the fresh heading context.
    chunkHeadings = activeHeadings()
    const prev = chunks[chunks.length - 1]
    if (!prev) return
    const tokens = enc.encode(prev.text)
    const tail = tokens.slice(Math.max(0, tokens.length - overlapTokens))
    if (tail.length > 0) {
      const overlap = enc.decode(tail)
      buf.push(overlap)
      bufTokens = tail.length
    }
  }

  for (const line of lines) {
    // Heading detection: update the stack, then treat the heading as
    // a normal line so it appears verbatim in the chunk text too.
    const m = /^(#{1,3})\s+(.*)$/.exec(line)
    if (m && m[1] && m[2] !== undefined) {
      const level = m[1].length // 1..3
      const text = m[2].trim()
      stack[level - 1] = text
      for (let i = level; i < stack.length; i++) stack[i] = null
      if (buf.length === 0) chunkHeadings = activeHeadings()
    }

    const lineTokens = enc.encode(line.length === 0 ? '\n' : line).length

    // Case 1: the line on its own is oversized — hard-split it.
    if (lineTokens > targetTokens) {
      // Flush whatever we have first, untouched.
      flush()
      startNewBufferWithOverlap()
      hardSplitLine(line, targetTokens, enc).forEach((piece, i) => {
        if (i > 0) {
          flush()
          startNewBufferWithOverlap()
        }
        buf.push(piece.text)
        bufTokens += piece.tokens
      })
      continue
    }

    // Case 2: adding this line would overflow the target — finalize
    // the current chunk and start a new one with overlap.
    if (bufTokens > 0 && bufTokens + lineTokens > targetTokens) {
      flush()
      startNewBufferWithOverlap()
    }

    if (buf.length === 0) chunkHeadings = activeHeadings()
    buf.push(line)
    bufTokens += lineTokens
  }

  flush()
  return chunks
}

interface Piece {
  text: string
  tokens: number
}

function hardSplitLine(line: string, targetTokens: number, enc: Tiktoken): Piece[] {
  const tokens = enc.encode(line)
  const pieces: Piece[] = []
  for (let i = 0; i < tokens.length; i += targetTokens) {
    const slice = tokens.slice(i, i + targetTokens)
    pieces.push({ text: enc.decode(slice), tokens: slice.length })
  }
  return pieces
}
