/**
 * Token-counter for usage tracking. Uses `js-tiktoken` `cl100k_base`
 * (the GPT-3.5/4 / Claude-ish family encoder) as an approximation —
 * the dashboard verification copy is explicit that these counts are
 * "≈ OpenAI tokenizer".
 *
 * The encoder is ~1MB to deserialise so it's cached at module scope,
 * matching the pattern in `rag/chunker.ts`. The same encoder instance
 * serves both the RAG chunker and the usage producer.
 */
import { getEncoding, type Tiktoken } from 'js-tiktoken'

let cachedEncoder: Tiktoken | null = null

function encoder(): Tiktoken {
  if (!cachedEncoder) cachedEncoder = getEncoding('cl100k_base')
  return cachedEncoder
}

export function tokenCount(s: string): number {
  if (!s) return 0
  return encoder().encode(s).length
}

export function byteLength(s: string): number {
  // Cloudflare workers expose TextEncoder; UTF-8 byte count.
  return new TextEncoder().encode(s).length
}
