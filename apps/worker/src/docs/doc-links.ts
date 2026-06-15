/**
 * Rebuild a doc's outgoing link graph from its markdown. Scans for links,
 * classifies each href (OKF doc-path → resolve by slug; legacy `/app/docs/{id}`
 * → resolve by id; external/anchor → ignored), resolves to target doc ids, and
 * replaces the doc's `doc_links` rows. Unresolved doc-path links are stored
 * dangling (target NULL) — legal per OKF §9, surfaced not rejected.
 *
 * Runs in the reindex consumer (which already has the markdown for both
 * authored and git docs), so the graph is eventually consistent with saves.
 */

import { classifyHref, scanMarkdownLinkHrefs } from '@ctxlayer/shared'
import type { Env } from '../env'
import { existingDocIds, getDocIdsBySlugs, replaceDocLinks } from '../db/queries/doc-links'

export async function rebuildDocLinks(env: Env, docId: string, markdown: string): Promise<void> {
  // Classify every doc-link href; collect the slugs/ids to resolve. Keep one
  // entry per raw ref (the doc_links PK is (source, target_ref)).
  const refs = new Map<string, { kind: 'slug' | 'id'; key: string }>()
  for (const href of scanMarkdownLinkHrefs(markdown)) {
    if (refs.has(href)) continue
    const t = classifyHref(href)
    if (!t) continue // external / anchor — not a doc link
    refs.set(href, t.kind === 'slug' ? { kind: 'slug', key: t.slug } : { kind: 'id', key: t.id })
  }

  const slugs = [...refs.values()].filter((r) => r.kind === 'slug').map((r) => r.key)
  const ids = [...refs.values()].filter((r) => r.kind === 'id').map((r) => r.key)
  const [bySlug, idsExist] = await Promise.all([
    getDocIdsBySlugs(env, slugs),
    existingDocIds(env, ids)
  ])

  const links: Array<{ targetRef: string; targetDocId: string | null }> = []
  for (const [ref, t] of refs) {
    // A doc never links to itself in the graph (self-links are harmless noise).
    const target =
      t.kind === 'slug' ? (bySlug.get(t.key) ?? null) : idsExist.has(t.key) ? t.key : null
    if (target === docId) continue
    links.push({ targetRef: ref, targetDocId: target })
  }
  await replaceDocLinks(env, docId, links)
}
