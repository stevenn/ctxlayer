/**
 * Bundle import: an uploaded OKF archive → docs grafted under a target folder,
 * with a two-pass link resolve (create all docs first, then re-point in-bundle
 * links at the newly-created docs). Reserved files (index.md / log.md) are
 * skipped. See docs/plan/N-okf-bundles.md.
 *
 * Synchronous for now, capped at MAX_DOCS so it fits a request's budget;
 * queue-backing for very large bundles is a follow-up.
 */

import {
  conceptPath,
  parseFrontmatter,
  rewriteMarkdownLinkHrefs,
  slugifyBody,
  slugifyHeading
} from '@ctxlayer/shared'
import type { Env } from '../env'
import { createDoc } from '../db/queries/docs'
import { writeSourceMarkdown } from '../storage/docs-r2'
import { applyOkfMetadata } from '../docs/okf-import'
import { type BundleFormat, unpackArchive } from './archive'
import { isReservedFile, readOkfVersion } from './reserved'

const MAX_DOCS = 200
const DEC = new TextDecoder()

export interface ImportResult {
  created: number
  skipped: number
  okfVersion: string | null
  errors: string[]
}

interface Created {
  docId: string
  folder: string | null
  slug: string
  source: string
}

export async function importBundle(
  env: Env,
  opts: { bytes: Uint8Array; format: BundleFormat; targetFolder: string | null; createdBy: string | null }
): Promise<ImportResult> {
  let files: { path: string; bytes: Uint8Array }[]
  try {
    files = unpackArchive(opts.bytes, opts.format)
  } catch (e) {
    return { created: 0, skipped: 0, okfVersion: null, errors: [`unpack failed: ${msg(e)}`] }
  }
  const concepts = files.filter((f) => /\.md$/i.test(f.path) && !isReservedFile(f.path))
  const indexFile = files.find((f) => f.path.toLowerCase().replace(/^\.?\//, '') === 'index.md')
  const okfVersion = indexFile ? readOkfVersion(DEC.decode(indexFile.bytes)) : null

  if (concepts.length === 0) {
    return { created: 0, skipped: files.length, okfVersion, errors: ['no concept files in archive'] }
  }
  if (concepts.length > MAX_DOCS) {
    return {
      created: 0,
      skipped: 0,
      okfVersion,
      errors: [`bundle too large: ${concepts.length} docs (max ${MAX_DOCS})`]
    }
  }

  const errors: string[] = []
  const byArchivePath = new Map<string, Created>()

  // Pass 1 — create every doc; record archive-path → created doc.
  for (const f of concepts) {
    const archivePath = normalizePath(f.path)
    try {
      const content = DEC.decode(f.bytes)
      const fm = parseFrontmatter(content)
      const base = (archivePath.split('/').pop() ?? archivePath).replace(/\.md$/i, '')
      const title = fm.known.title?.trim() || base || 'Untitled'
      const folder = bundleFolderFor(opts.targetFolder, archivePath)
      const created = await createDoc(env, {
        title,
        slug: slugifyBody(base, 90) || undefined,
        folder,
        createdBy: opts.createdBy
      })
      await writeSourceMarkdown(env, created.id, content)
      await applyOkfMetadata(env, created.id, fm.known, fm.raw)
      byArchivePath.set(archivePath, {
        docId: created.id,
        folder: created.folder,
        slug: created.slug,
        source: content
      })
    } catch (e) {
      errors.push(`${f.path}: ${msg(e)}`)
    }
  }

  // Pass 2 — rewrite in-bundle links to the new docs' concept paths, reindex.
  for (const [archivePath, c] of byArchivePath) {
    const rewritten = rewriteMarkdownLinkHrefs(c.source, (href) => {
      const targetPath = resolveArchiveLink(href, archivePath)
      if (!targetPath) return null
      const t = byArchivePath.get(targetPath)
      return t ? conceptPath(t.folder, t.slug) : null // unknown target → leave (dangling, tolerated)
    })
    if (rewritten !== c.source) await writeSourceMarkdown(env, c.docId, rewritten)
    try {
      // Best-effort reindex (imported docs chunk from source.md, like git docs).
      await env.DOC_REINDEX_QUEUE?.send({
        docId: c.docId,
        revisionId: `import:${c.docId}`,
        source: 'git'
      })
    } catch {
      /* reindex enqueue is best-effort */
    }
  }

  return {
    created: byArchivePath.size,
    skipped: files.length - concepts.length,
    okfVersion,
    errors
  }
}

/** Folder for an archive file: targetFolder + slugified dir segments, depth ≤ 5. */
function bundleFolderFor(targetFolder: string | null, archivePath: string): string | null {
  const dir = archivePath.includes('/') ? archivePath.slice(0, archivePath.lastIndexOf('/')) : ''
  const rootSegs = (targetFolder ?? '')
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter(Boolean)
  const dirSegs = dir.split('/').map(slugifyHeading).filter(Boolean)
  const segs = [...rootSegs, ...dirSegs].slice(0, 5)
  return segs.length === 0 ? null : `/${segs.join('/')}`
}

/** Resolve an in-bundle link href (from a doc at `fromPath`) to a normalized
 *  bundle-relative archive path, or null for external / non-`.md` links. */
function resolveArchiveLink(href: string, fromPath: string): string | null {
  const h = (href.split(/[?#]/)[0] ?? '').trim()
  if (!h || /^[a-z][a-z0-9+.-]*:/i.test(h) || h.startsWith('//') || h.startsWith('#')) return null
  if (!/\.md$/i.test(h)) return null
  if (h.startsWith('/')) return normalizePath(h.slice(1))
  const dir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : ''
  return normalizePath(`${dir}/${h}`)
}

/** Collapse `.` / `..` and leading slashes to a clean relative path. */
function normalizePath(p: string): string {
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return out.join('/')
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : 'error'
}
