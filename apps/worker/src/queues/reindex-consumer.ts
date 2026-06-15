import { z } from 'zod'
import { splitFrontmatter } from '@ctxlayer/shared'
import type { Env } from '../env'
import { getDocReindexState, setDocIndexedState } from '../db/queries/docs'
import { listTagsForDoc } from '../db/queries/doc-tags'
import { readRevision, readSourceMarkdown } from '../storage/docs-r2'
import { renderBlocksToMarkdown } from '../rag/markdown'
import { chunkMarkdown, type Chunk } from '../rag/chunker'
import { embed } from '../rag/embedder'
import { upsertChunks } from '../rag/index'
import { notify } from '../ops/alert'

// Mirror of wrangler.toml's `max_retries` on the reindex consumer: on the
// final attempt we alert + ack (so a poison message is surfaced, not silently
// dropped by the platform) instead of retrying into the void.
const MAX_REINDEX_ATTEMPTS = 5

/**
 * Batch consumer for ctxlayer-reindex.
 *
 * Per message: R2 read → markdown render → chunk → embed → upsert.
 *
 * Failure model:
 *   - Malformed message body → ack + log. Replaying would loop the
 *     batch; G4 in PLAN.md tracks the DLQ work.
 *   - Doc/revision missing (e.g. deleted between produce and consume)
 *     → ack + log; nothing to reindex.
 *   - `PermanentError` (markdown render, schema) → ack + log. Retrying
 *     a permanent error would loop until the message ages out; ack so
 *     the queue drains and a human picks it up via the log.
 *   - Any other thrown error (R2 / Workers AI / D1) → `retry()` for the
 *     queue's exponential-backoff redelivery.
 */
const ReindexMessage = z.object({
  docId: z.string().min(1),
  revisionId: z.string().min(1),
  // 'git' ⇒ the doc's canonical body is raw markdown in R2
  // (docs/{docId}/source.md), chunked directly. Absent ⇒ ordinary doc
  // whose body is the BlockNote revision rendered to markdown.
  source: z.literal('git').optional(),
  // Bypass the unchanged-content skip. Set by the admin "reindex all"
  // action, whose whole point is rebuilding vectors for content whose
  // hash hasn't moved (e.g. after a chunking/embedding change).
  force: z.boolean().optional()
})

/**
 * Thrown by `handle()` when the message can never succeed on its own:
 * malformed content, bad block shape, etc. The consumer maps this to
 * `msg.ack()` so the queue isn't poisoned by retrying forever.
 */
class PermanentError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'PermanentError'
  }
}

export async function reindexConsumer(
  batch: MessageBatch,
  env: Env,
  _ctx: ExecutionContext
): Promise<void> {
  // Dedupe by docId within the batch, keeping the LAST message per doc:
  // every run reads the doc's CURRENT body + tags anyway, so a superseded
  // duplicate would redo identical work. Superseded messages are acked
  // outright; their `force` flag (if any) is folded into the survivor so
  // a forced rebuild can't be lost to dedupe.
  const parsedBatch = batch.messages.map((msg) => ({
    msg,
    parsed: ReindexMessage.safeParse(msg.body)
  }))
  const lastMsgForDoc = new Map<string, Message>()
  const forcedDocs = new Set<string>()
  for (const { msg, parsed } of parsedBatch) {
    if (!parsed.success) continue
    lastMsgForDoc.set(parsed.data.docId, msg)
    if (parsed.data.force) forcedDocs.add(parsed.data.docId)
  }

  for (const { msg, parsed } of parsedBatch) {
    if (!parsed.success) {
      console.error('reindex-consumer: malformed message; dropping', {
        id: msg.id,
        issues: parsed.error.issues
      })
      msg.ack()
      continue
    }
    if (lastMsgForDoc.get(parsed.data.docId) !== msg) {
      // Superseded by a later message for the same doc in this batch.
      msg.ack()
      continue
    }
    try {
      await handle(env, { ...parsed.data, force: forcedDocs.has(parsed.data.docId) })
      msg.ack()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // wrangler dev quirk: `remote = true` on the Vectorize / AI
      // bindings works for the fetch handler but not for queue
      // consumers (they run in a separate context that doesn't get
      // the remote proxy). The error message is distinctive. In dev
      // we ack the message instead of retrying-then-dropping so doc
      // saves keep flowing; search_docs won't find anything until
      // you run the worker remote (`wrangler dev --remote`) or
      // deploy. In production this branch is never hit — both
      // bindings resolve normally.
      if (/needs to be run remotely/i.test(message)) {
        console.warn('reindex-consumer: skipping in dev (binding not remote)', {
          id: msg.id,
          body: parsed.data,
          err: message
        })
        msg.ack()
        continue
      }
      if (err instanceof PermanentError) {
        // Acking instead of retrying — replays of a permanent error
        // just waste queue budget. The log line is the trail for a
        // human to investigate.
        const cause = err.cause
        console.error('reindex-consumer: permanent failure; dropping', {
          id: msg.id,
          body: parsed.data,
          err: message,
          cause: cause instanceof Error ? cause.message : undefined
        })
        // A doc that will never index is silently unsearchable — surface it.
        await notify(env, {
          level: 'error',
          event: 'reindex.permanent_failure',
          detail: `doc=${parsed.data.docId}: ${message}`
        })
        msg.ack()
        continue
      }
      // Transient (R2 / Workers AI / D1). Retry with backoff — but once the
      // retry budget is spent, alert + ack rather than let the platform drop
      // it silently (the doc would stay unsearchable with no signal).
      if (msg.attempts >= MAX_REINDEX_ATTEMPTS) {
        console.error('reindex-consumer: retry budget exhausted; dropping', {
          id: msg.id,
          body: parsed.data,
          attempts: msg.attempts,
          err: message
        })
        await notify(env, {
          level: 'error',
          event: 'reindex.poison',
          detail: `doc=${parsed.data.docId} after ${msg.attempts} attempts: ${message}`
        })
        msg.ack()
        continue
      }
      console.error('reindex-consumer: pipeline error; retrying', {
        id: msg.id,
        body: parsed.data,
        attempts: msg.attempts,
        err: message
      })
      msg.retry()
    }
  }
}

async function handle(
  env: Env,
  msg: { docId: string; revisionId: string; source?: 'git'; force?: boolean }
): Promise<void> {
  const { docId, revisionId } = msg
  const doc = await getDocReindexState(env, docId)
  if (!doc) {
    console.log('reindex-consumer: doc gone; skipping', { docId, revisionId })
    return
  }

  let markdown: string
  if (msg.source === 'git') {
    // Git-synced doc: canonical body is raw markdown in R2. No blocks
    // render (and no PermanentError path — there's nothing to mis-shape).
    const src = await readSourceMarkdown(env, docId)
    if (src === null) {
      console.log('reindex-consumer: git source.md missing; skipping', { docId, revisionId })
      return
    }
    // Strip OKF/YAML frontmatter so the metadata block isn't embedded as
    // body text (it would pollute the chunks + dilute relevance).
    markdown = splitFrontmatter(src).body
  } else {
    const content = await readRevision(env, docId, revisionId)
    if (!content) {
      console.log('reindex-consumer: revision body missing; skipping', { docId, revisionId })
      return
    }
    try {
      markdown = renderBlocksToMarkdown(content.blocks)
    } catch (err) {
      // Permanent: bad block shape will trip on every redelivery. Log a
      // sample so the offending block is identifiable from the queue
      // log, then mark the failure permanent so the consumer drops the
      // message instead of looping it.
      console.error('reindex-consumer: markdown render failed', {
        docId,
        revisionId,
        blockCount: Array.isArray(content.blocks) ? content.blocks.length : 'not-an-array',
        sample: safeSample(content.blocks)
      })
      throw new PermanentError('markdown render failed', { cause: err })
    }
  }
  if (!markdown) {
    // Empty body — nothing to embed. M2c's delete-by-docId-prefix will
    // still want to run so search results don't reference an empty
    // doc, but in M2b/1 we just log and return.
    console.log('reindex-consumer: empty markdown; skipping', { docId, revisionId })
    return
  }

  // Tags are read BEFORE the skip check because they shape the chunk
  // metadata (scope filter) — a tag-only change must reindex even when
  // the body is byte-identical, so they're part of the content hash.
  const tags = await listTagsForDoc(env, docId)
  const contentHash = await indexContentHash(doc.title, markdown, tags)
  if (!msg.force && doc.last_indexed_hash === contentHash) {
    console.log('reindex-consumer: content unchanged; skipping', { docId, revisionId })
    return
  }

  const chunks = chunkMarkdown(markdown, { title: doc.title })
  // Embed the doc title + section breadcrumb ALONG WITH each chunk's
  // body, so the doc/section identity is part of every vector. A query
  // that matches the title (e.g. "yuki architecture" → a doc titled
  // "Yuki Architecture Analysis") then matches the doc's chunks
  // semantically. The stored snippet (metadata.text) stays the raw body,
  // so result snippets read naturally — only the embedding input carries
  // the header.
  const { vectors } = await embed(
    env,
    chunks.map((c) => embedInput(doc.title, c))
  )
  // Free-form tags aren't part of the search filter today; we pass only
  // team + product onto chunk metadata. Tags live in `doc_tags` for the
  // editor + (future) drill-down browse, not the scope predicate.
  // `is_global` is derived in upsertChunks from these two.
  await upsertChunks(env, {
    docId,
    revisionId,
    title: doc.title,
    chunks,
    vectors,
    tags: { teams: tags.teams, products: tags.products },
    previousChunkCount: doc.chunk_count
  })
  // Cache the count (orphan-cleanup high-water mark) + the hash that
  // produced it. Reached only when the upsert succeeded — in dev the
  // soft-skipped Vectorize binding throws before this line, so no hash
  // is recorded for an index that never received vectors.
  await setDocIndexedState(env, docId, chunks.length, contentHash)
}

/**
 * Hash of everything that shapes a doc's Vectorize chunks: title
 * (embedded into every chunk + stored in metadata), the markdown body,
 * and the team/product tags (scope-filter metadata). Tag arrays are
 * sorted so ordering noise doesn't defeat the skip.
 */
async function indexContentHash(
  title: string,
  markdown: string,
  tags: { teams: string[]; products: string[] }
): Promise<string> {
  const payload = JSON.stringify({
    title,
    markdown,
    teams: [...tags.teams].sort(),
    products: [...tags.products].sort()
  })
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Compose the text we embed for a chunk: doc title + heading breadcrumb
 * (deduped against the title) + the chunk body. Title-only / heading-
 * only headers are dropped to nothing extra.
 */
function embedInput(title: string, c: Chunk): string {
  const crumb = c.headings.filter((h) => h && h !== title).join(' › ')
  const header = [title, crumb].filter(Boolean).join('\n')
  return header ? `${header}\n\n${c.text}` : c.text
}

function safeSample(blocks: unknown): string {
  try {
    return JSON.stringify(blocks).slice(0, 500)
  } catch {
    return '<unstringifiable>'
  }
}
