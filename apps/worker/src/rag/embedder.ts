/**
 * Workers AI embedder. `@cf/baai/bge-base-en-v1.5` returns 768-d
 * vectors and accepts up to 100 inputs per call. Larger doc
 * revisions are batched.
 *
 * On any batch failure we retry the whole batch once. Failing again
 * surfaces an error to the consumer, which `retry()`s the message —
 * Cloudflare Queues will redeliver until the configured limit (DLQ
 * lands later; see G4).
 */

import type { Env } from '../env'

const MODEL = '@cf/baai/bge-base-en-v1.5'
const VECTOR_DIM = 768
const BATCH_SIZE = 100

export interface EmbedResult {
  /** Same order as input, length matches. */
  vectors: number[][]
}

// bge-base is trained for ASYMMETRIC retrieval: the QUERY is prefixed with
// this instruction, the passages are not. Passages were indexed without it,
// so adding it query-side is the trained-correct setup AND needs no
// reindex. See https://huggingface.co/BAAI/bge-base-en-v1.5.
const QUERY_INSTRUCTION = 'Represent this sentence for searching relevant passages:'

/**
 * Embed search QUERIES (not passages): prepends the bge query instruction
 * before delegating to `embed`. Use this on the retrieval side only.
 */
export async function embedQueries(env: Env, texts: string[]): Promise<EmbedResult> {
  return embed(
    env,
    texts.map((t) => `${QUERY_INSTRUCTION} ${t}`)
  )
}

export async function embed(env: Env, texts: string[]): Promise<EmbedResult> {
  if (texts.length === 0) return { vectors: [] }
  const all: number[][] = []
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE)
    const vecs = await runBatchWithRetry(env, batch)
    if (vecs.length !== batch.length) {
      throw new Error(`embedder: batch length mismatch (in=${batch.length}, out=${vecs.length})`)
    }
    for (const v of vecs) {
      if (v.length !== VECTOR_DIM) {
        throw new Error(
          `embedder: unexpected vector dimension ${v.length} (expected ${VECTOR_DIM})`
        )
      }
    }
    all.push(...vecs)
  }
  return { vectors: all }
}

async function runBatchWithRetry(env: Env, batch: string[]): Promise<number[][]> {
  try {
    return await runBatch(env, batch)
  } catch (err) {
    console.warn('embedder: batch failed, retrying once', {
      size: batch.length,
      err: err instanceof Error ? err.message : String(err)
    })
    return runBatch(env, batch)
  }
}

async function runBatch(env: Env, batch: string[]): Promise<number[][]> {
  // Workers AI accepts { text: string | string[] } and returns
  // { data: number[][], shape: [n, dim] }. The runtime binding's
  // typing is permissive; cast through unknown.
  const res = (await env.AI.run(MODEL, { text: batch } as never)) as unknown as {
    data?: number[][]
    shape?: number[]
  }
  if (!res || !Array.isArray(res.data)) {
    throw new Error('embedder: response missing data array')
  }
  return res.data
}

