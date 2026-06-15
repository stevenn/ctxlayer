/**
 * Rewrite in-app doc links to the target's CURRENT OKF concept path. This is
 * how move-consistency is achieved on export (see docs/plan/N-okf-bundles.md):
 * a doc that links to a moved doc always exports the right path, without ever
 * mutating the source body. Each doc-link href (a concept path, or a legacy
 * `/app/docs/{id}`) is resolved to its target and re-emitted as
 * `conceptPath(folder, slug)`; external + dangling links pass through unchanged.
 *
 * `bundleRoot` re-roots the absolute path relative to a bundle root (for bundle
 * export); omit it (per-doc export) to keep paths absolute in the global
 * hierarchy.
 */

import {
  classifyHref,
  conceptPath,
  rewriteMarkdownLinkHrefs,
  scanMarkdownLinkHrefs
} from '@ctxlayer/shared'
import type { Env } from '../env'
import { getDocConceptsByIds, getDocConceptsBySlugs } from '../db/queries/doc-links'

export async function rewriteDocLinkHrefs(
  env: Env,
  markdown: string,
  opts: { bundleRoot?: string } = {}
): Promise<string> {
  const slugs: string[] = []
  const ids: string[] = []
  for (const href of scanMarkdownLinkHrefs(markdown)) {
    const t = classifyHref(href)
    if (!t) continue
    if (t.kind === 'slug') slugs.push(t.slug)
    else ids.push(t.id)
  }
  if (slugs.length === 0 && ids.length === 0) return markdown

  const [bySlug, byId] = await Promise.all([
    getDocConceptsBySlugs(env, slugs),
    getDocConceptsByIds(env, ids)
  ])

  return rewriteMarkdownLinkHrefs(markdown, (href) => {
    const t = classifyHref(href)
    if (!t) return null
    const doc = t.kind === 'slug' ? bySlug.get(t.slug) : byId.get(t.id)
    if (!doc) return null // dangling — leave the href as authored
    return reRoot(conceptPath(doc.folder, doc.slug), opts.bundleRoot)
  })
}

/** Make an absolute concept path bundle-relative (still leading-slashed). */
function reRoot(absPath: string, bundleRoot?: string): string {
  if (!bundleRoot || bundleRoot === '/' || bundleRoot === '') return absPath
  const root = bundleRoot.replace(/\/+$/, '')
  if (absPath === root || absPath.startsWith(`${root}/`)) {
    return absPath.slice(root.length) || absPath
  }
  return absPath // outside the bundle — keep absolute (cross-bundle link)
}
