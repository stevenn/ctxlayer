import { splitFrontmatter } from '@ctxlayer/shared'
import type { Env } from '../env'
import { renderBlocksToMarkdown } from '../rag/markdown'
import { readSnapshot, readSourceMarkdown } from '../storage/docs-r2'

/**
 * A doc's markdown body for the agent surface (`get_doc` + the doc
 * resource): the editor snapshot when one exists, else the imported
 * source.md with its frontmatter stripped. Git-synced and bundle-imported
 * docs have no snapshot until a human first opens them in the editor —
 * without this fallback they are searchable (chunked from source.md) yet
 * read as "empty document" here. Mirrors `okfBody`'s fallback.
 */
export async function docMarkdown(env: Env, docId: string): Promise<string> {
  const snap = await readSnapshot(env, docId)
  if (snap) return renderBlocksToMarkdown(snap.blocks)
  const src = await readSourceMarkdown(env, docId)
  return src !== null ? splitFrontmatter(src).body.replace(/^\s+/, '') : ''
}
