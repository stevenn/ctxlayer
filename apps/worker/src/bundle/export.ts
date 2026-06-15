/**
 * Bundle export: a folder subtree → an OKF bundle archive (tar.gz / zip).
 * Each doc is written at its concept path relative to the bundle root, with
 * its links re-rooted to the bundle; a root index.md (okf_version + contents)
 * and log.md (from explicit revisions) are generated. See N-okf-bundles.md.
 */

import { conceptPath } from '@ctxlayer/shared'
import type { Env } from '../env'
import {
  type DocOkfExportRow,
  listBundleLogEntries,
  listDocOkfExportsUnderFolder
} from '../db/queries/docs'
import { listTagsForDoc } from '../db/queries/doc-tags'
import { rewriteDocLinkHrefs } from '../docs/link-rewrite'
import { okfBody, okfFrontmatterBlock } from '../docs/okf'
import { type BundleFile, type BundleFormat, FORMAT_META, packArchive } from './archive'
import { type BundleConcept, generateIndexMd, generateLogMd } from './reserved'

export interface BundleExport {
  bytes: Uint8Array
  filename: string
  contentType: string
  docCount: number
}

export async function composeBundle(
  env: Env,
  root: string,
  format: BundleFormat
): Promise<BundleExport> {
  const rows = await listDocOkfExportsUnderFolder(env, root)
  const enc = new TextEncoder()
  const files: BundleFile[] = []
  const concepts: BundleConcept[] = []

  for (const row of rows) {
    const md = await composeDocMarkdown(env, row, root)
    const rel = relPath(row.folder, row.slug, root)
    files.push({ path: rel, bytes: enc.encode(md) })
    concepts.push({ relPath: rel, title: row.title, description: row.description })
  }

  files.push({ path: 'index.md', bytes: enc.encode(generateIndexMd(concepts)) })
  const log = (await listBundleLogEntries(env, root)).map((r) => ({
    date: new Date(r.created_at * 1000).toISOString().slice(0, 10),
    text: r.title
  }))
  if (log.length > 0) files.push({ path: 'log.md', bytes: enc.encode(generateLogMd(log)) })

  const meta = FORMAT_META[format]
  return {
    bytes: packArchive(files, format),
    filename: `${bundleName(root)}.${meta.ext}`,
    contentType: meta.contentType,
    docCount: rows.length
  }
}

async function composeDocMarkdown(env: Env, row: DocOkfExportRow, root: string): Promise<string> {
  const tags = (await listTagsForDoc(env, row.id)).tags
  const block = okfFrontmatterBlock(row, tags, { synthesizeType: true, includeTimestamp: true })
  const body = await okfBody(env, row)
  const linked = await rewriteDocLinkHrefs(env, body, { bundleRoot: root })
  return block + linked.replace(/^\n+/, '')
}

/** A doc's concept path relative to the bundle root (no leading slash). */
export function relPath(folder: string | null, slug: string, root: string): string {
  const abs = conceptPath(folder, slug) // /a/b/slug.md
  const r = root === '/' || root === '' ? '' : root.replace(/\/+$/, '')
  if (r && (abs === r || abs.startsWith(`${r}/`))) return abs.slice(r.length + 1)
  return abs.replace(/^\/+/, '')
}

/** Download filename stem for a bundle root. */
export function bundleName(root: string): string {
  const r = (root === '/' || root === '' ? '' : root).replace(/^\/+|\/+$/g, '')
  return r ? r.replace(/\//g, '-') : 'bundle'
}
