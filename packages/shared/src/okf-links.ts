/**
 * OKF-native doc-link helpers, shared by the worker (link-graph resolution,
 * bundle export/import) and the SPA (link picker, click resolution).
 *
 * A doc-to-doc link is stored in the body as the target's OKF **concept path**
 * — `${folder}/${slug}.md`, root-absolute in the ctxlayer folder hierarchy
 * (also a valid OKF bundle path). There is no `/app/docs/{id}` scheme; the path
 * IS the href. See docs/plan/N-okf-bundles.md.
 */

/** The OKF concept path (href) for a doc: `/specs/api/auth.md`, root → `/auth.md`. */
export function conceptPath(folder: string | null | undefined, slug: string): string {
  const dir = (folder ?? '').replace(/\/+$/, '') // folder is already leading-slashed or ''
  return `${dir}/${slug}.md`
}

export type LinkTarget =
  | { kind: 'slug'; slug: string } // an in-app doc link (resolve by slug)
  | { kind: 'id'; id: string } // legacy /app/docs/{id} link
  | null // external URL, anchor, or anything not a doc link

/**
 * Classify a link href. Returns how to resolve it to a doc, or null when it's
 * not a doc link (external URL, mailto, in-page anchor, query-only). The path
 * forms `/dir/slug.md`, `./slug.md`, `../x/slug.md` all resolve by their
 * basename slug (slugs are globally unique).
 */
export function classifyHref(href: string): LinkTarget {
  const h = href.trim()
  if (h === '') return null
  // External / protocol / protocol-relative / mailto / tel.
  if (/^[a-z][a-z0-9+.-]*:/i.test(h) || h.startsWith('//')) return null
  // In-page anchor or query-only.
  if (h.startsWith('#') || h.startsWith('?')) return null
  // Legacy internal doc link.
  const legacy = /^\/app\/docs\/([^/?#]+)/.exec(h)
  if (legacy) return { kind: 'id', id: decodeURIComponent(legacy[1] ?? '') }
  // OKF concept path: ends in `.md` (strip any query/hash first).
  const path = h.split(/[?#]/)[0] ?? h
  if (/\.md$/i.test(path)) {
    const base = path.split('/').pop() ?? ''
    const slug = base.replace(/\.md$/i, '')
    return slug ? { kind: 'slug', slug } : null
  }
  return null
}

/** Extract every link href from markdown `[text](href)` syntax. */
export function scanMarkdownLinkHrefs(markdown: string): string[] {
  const out: string[] = []
  // [label](href) — href is everything up to whitespace or the closing paren;
  // an optional "title" after a space is ignored. Skips image links (![...]).
  const re = /(!?)\[[^\]]*\]\(\s*([^()\s]+)(?:\s+[^()]*)?\)/g
  for (const m of markdown.matchAll(re)) {
    if (m[1] === '!') continue // image, not a link
    const href = m[2]
    if (href) out.push(href)
  }
  return out
}
