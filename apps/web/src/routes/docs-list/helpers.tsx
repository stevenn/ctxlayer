import type { DocSummary, FolderTreeNode, UserSummary } from '@ctxlayer/shared'
import { explain as explainBase } from '../../lib/explain'

// The library is split into two top-level groups: authored docs (Home)
// and git-synced docs (Code Docs). Selection tracks which group + folder.
export type FolderGroup = 'home' | 'code'
export interface FolderSelection {
  group: FolderGroup
  path: string | null
  // Only meaningful for the code group: which git source (repo) the
  // selection is scoped to. Code docs hang under a virtual per-repo node,
  // so a folder path alone isn't unique across repos. Undefined for home.
  sourceId?: string | null
}

export const EMPTY_DOCS: DocSummary[] = []

export const isGitDoc = (d: DocSummary): boolean => d.gitSourceId != null

export interface TreeNode {
  // Just the leaf segment, e.g. "v2" within "/specs/api/v2".
  label: string
  // Absolute path; null only for the synthetic root.
  path: string | null
  docCount: number
  descendantDocCount: number
  children: TreeNode[]
}

/**
 * Build a real tree from the flat folder list. The server returns one
 * row per populated path; intermediate ancestors aren't necessarily
 * populated and may not appear, so we synthesise them here with zero
 * direct doc count.
 *
 * Root node represents "docs with no folder" — selecting a folder shows
 * only docs directly in it, so the root is *not* a synthetic "everything"
 * bucket. `descendantDocCount` is still tracked so the delete gate can
 * refuse to drop a folder that has docs below it.
 */
/**
 * Derive folder-tree nodes from a set of docs (one group). Every folder
 * is represented by ≥1 doc (no empty folders exist in the storage model),
 * so the docs list is a complete source — including ancestors, with the
 * descendant counts the delete-gate needs.
 */
export function computeFolderNodes(docs: DocSummary[]): FolderTreeNode[] {
  const paths = new Set<string>()
  for (const d of docs) {
    if (!d.folder) continue
    const segs = d.folder.slice(1).split('/')
    for (let i = 1; i <= segs.length; i++) paths.add('/' + segs.slice(0, i).join('/'))
  }
  const nodes: FolderTreeNode[] = []
  for (const path of paths) {
    let docCount = 0
    let descendantDocCount = 0
    for (const d of docs) {
      if (!d.folder) continue
      if (d.folder === path) docCount++
      if (d.folder === path || d.folder.startsWith(`${path}/`)) descendantDocCount++
    }
    nodes.push({ path, docCount, descendantDocCount })
  }
  return nodes
}

export function buildTree(
  folders: FolderTreeNode[],
  rootDocCount: number,
  rootLabel: string
): TreeNode {
  const root: TreeNode = {
    label: rootLabel,
    path: null,
    docCount: rootDocCount,
    descendantDocCount: rootDocCount,
    children: []
  }
  // Index by path for synthesised-parent lookup.
  const byPath = new Map<string, TreeNode>()
  byPath.set('', root)

  const sorted = [...folders].sort((a, b) => a.path.localeCompare(b.path))
  for (const f of sorted) {
    const segments = f.path.slice(1).split('/')
    let parentKey = ''
    for (let i = 0; i < segments.length; i++) {
      const path = '/' + segments.slice(0, i + 1).join('/')
      let node = byPath.get(path)
      if (!node) {
        node = {
          label: segments[i] ?? '',
          path,
          docCount: 0,
          descendantDocCount: 0,
          children: []
        }
        byPath.set(path, node)
        const parent = byPath.get(parentKey) ?? root
        parent.children.push(node)
      }
      if (path === f.path) {
        node.docCount = f.docCount
        node.descendantDocCount = f.descendantDocCount
      }
      parentKey = path
    }
  }
  return root
}

export interface RepoGroup {
  sourceId: string
  label: string
  tree: TreeNode
}

/**
 * Group git-synced docs by their source repo, building a folder subtree
 * per repo. Each repo becomes a virtual top-level node (path === null)
 * whose badge counts every doc in the repo and whose folder children
 * narrow to exact paths — so the library hierarchy reads
 * `Code Docs › <repo> › <folder…>`. Sorted by repo label for stability.
 */
export function groupCodeDocsByRepo(docs: DocSummary[]): RepoGroup[] {
  const bySource = new Map<string, DocSummary[]>()
  for (const d of docs) {
    if (!d.gitSourceId) continue
    const arr = bySource.get(d.gitSourceId)
    if (arr) arr.push(d)
    else bySource.set(d.gitSourceId, [d])
  }
  const groups: RepoGroup[] = []
  for (const [sourceId, repoDocs] of bySource) {
    const first = repoDocs[0]!
    const label = first.gitSourceName || first.gitSourceSlug || 'Unknown repo'
    // Mirror the Home root: the repo node lists only docs sitting directly
    // at the repo's top level (no sub-folder) and its badge counts those;
    // sub-folders narrow from there. Exact-folder matching, same as the
    // authored-doc browser — no recursive dump of the whole repo.
    const tree = buildTree(
      computeFolderNodes(repoDocs),
      repoDocs.filter((d) => !d.folder).length,
      label
    )
    groups.push({ sourceId, label, tree })
  }
  groups.sort((a, b) => a.label.localeCompare(b.label))
  return groups
}

export function personLabel(u: UserSummary | null | undefined): string {
  if (!u) return '—'
  if (u.name && u.name.length > 0) return u.name
  const at = u.email.indexOf('@')
  return at > 0 ? u.email.slice(0, at) : u.email
}

export function filterDocs(docs: DocSummary[], query: string): DocSummary[] {
  const q = query.trim().toLowerCase()
  if (!q) return docs
  return docs.filter((d) => {
    if (d.title.toLowerCase().includes(q)) return true
    if (d.slug.toLowerCase().includes(q)) return true
    const creator = personLabel(d.createdBy).toLowerCase()
    if (creator.includes(q)) return true
    const editor = personLabel(d.updatedBy ?? d.createdBy).toLowerCase()
    if (editor.includes(q)) return true
    return false
  })
}

export function explain(err: unknown): string {
  return explainBase(err, {
    413: 'The markdown file is too large (max 2 MB).'
  })
}

export function formatRelative(ts: number): string {
  const diff = Math.floor(Date.now() / 1000) - ts
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`
  return new Date(ts * 1000).toLocaleDateString()
}
