import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Alert,
  Badge,
  Button,
  FileButton,
  Group,
  Menu,
  Modal,
  Stack,
  Text,
  TextInput,
  Title,
  Tooltip
} from '@mantine/core'
import { useCreateBlockNote } from '@blocknote/react'
import type {
  DocSummary,
  FolderTreeNode,
  UserSummary
} from '@ctxlayer/shared'
import {
  ApiError,
  ApiSchemaError,
  adminReindexAllDocs,
  createDoc,
  deleteFolder,
  fetchDocs,
  fetchMe,
  patchDoc,
  putDocContent,
  renameFolder
} from '../lib/api'
import { useDialogs } from '../lib/dialogs'

type Status =
  | { kind: 'loading' }
  | { kind: 'ready'; docs: DocSummary[] }
  | { kind: 'error'; message: string }

// The library is split into two top-level groups: authored docs (Home)
// and git-synced docs (Code Docs). Selection tracks which group + folder.
type FolderGroup = 'home' | 'code'
interface FolderSelection {
  group: FolderGroup
  path: string | null
  // Only meaningful for the code group: which git source (repo) the
  // selection is scoped to. Code docs hang under a virtual per-repo node,
  // so a folder path alone isn't unique across repos. Undefined for home.
  sourceId?: string | null
}

const EMPTY_DOCS: DocSummary[] = []

const isGitDoc = (d: DocSummary): boolean => d.gitSourceId != null

export function DocsList() {
  const nav = useNavigate()
  const dialogs = useDialogs()
  const [status, setStatus] = useState<Status>({ kind: 'loading' })
  const [createOpen, setCreateOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  // Client-side filter over the list. Title / slug / creator / kind /
  // folder are all matched case-insensitively. RAG search lives behind
  // the hero box (semantic) — this bar is "find a doc I know exists".
  const [query, setQuery] = useState('')
  // Selected (group, folder). null path = the group's root.
  const [selected, setSelected] = useState<FolderSelection>({ group: 'home', path: null })
  const [isAdmin, setIsAdmin] = useState(false)
  const [reindexing, setReindexing] = useState(false)

  useEffect(() => {
    const ctrl = new AbortController()
    fetchMe(ctrl.signal).then(
      (me) => !ctrl.signal.aborted && setIsAdmin(me.role === 'admin'),
      () => {
        /* non-admin / unauthenticated — just hide the admin action */
      }
    )
    return () => ctrl.abort()
  }, [])

  async function onReindexAll() {
    setReindexing(true)
    try {
      const { queued } = await adminReindexAllDocs()
      await dialogs.alert({
        title: 'Reindex queued',
        message: `Queued ${queued} doc${queued === 1 ? '' : 's'} for reindexing. Search will catch up over the next minute or two.`
      })
    } catch (err) {
      await dialogs.alert({ title: 'Reindex failed', message: explain(err) })
    } finally {
      setReindexing(false)
    }
  }

  const reload = useCallback((signal?: AbortSignal) => {
    setStatus({ kind: 'loading' })
    fetchDocs(signal).then(
      (docs) => {
        if (!signal?.aborted) setStatus({ kind: 'ready', docs })
      },
      (err) => {
        if (signal?.aborted) return
        setStatus({ kind: 'error', message: explain(err) })
      }
    )
  }, [])

  useEffect(() => {
    const ctrl = new AbortController()
    reload(ctrl.signal)
    return () => ctrl.abort()
  }, [reload])

  // Partition docs by origin and derive each group's folder tree
  // client-side (the folders endpoint can't distinguish git from
  // authored — and every folder is represented by at least one doc, so
  // the docs list is a complete source).
  const docs = status.kind === 'ready' ? status.docs : EMPTY_DOCS
  const homeDocs = useMemo(() => docs.filter((d) => !isGitDoc(d)), [docs])
  const codeDocs = useMemo(() => docs.filter(isGitDoc), [docs])
  const homeFolders = useMemo(() => computeFolderNodes(homeDocs), [homeDocs])

  async function onRenameFolder(oldPath: string) {
    const next = await dialogs.prompt({
      title: 'Rename folder',
      message: `Rename "${oldPath}" to:`,
      defaultValue: oldPath,
      confirmLabel: 'Rename'
    })
    if (!next || next === oldPath) return
    try {
      const { moved } = await renameFolder({ oldPath, newPath: next })
      await dialogs.alert({
        title: 'Folder renamed',
        message: `Moved ${moved} doc${moved === 1 ? '' : 's'}.`
      })
      if (selected.path?.startsWith(oldPath)) {
        setSelected({ group: 'home', path: next + selected.path.slice(oldPath.length) })
      }
      reload()
    } catch (err) {
      await dialogs.alert({ title: 'Rename failed', message: explain(err) })
    }
  }

  async function onMoveDoc(doc: DocSummary) {
    const next = await dialogs.prompt({
      title: 'Move doc',
      message: `Move "${doc.title}" to a folder path (e.g. /specs/api) or leave blank for Root.`,
      defaultValue: doc.folder ?? '',
      placeholder: '/specs/api',
      confirmLabel: 'Move'
    })
    if (next === null) return
    const target = next.trim() === '' ? null : next.trim()
    if (target === doc.folder) return
    try {
      await patchDoc(doc.id, { folder: target })
      reload()
    } catch (err) {
      await dialogs.alert({ title: 'Move failed', message: explain(err) })
    }
  }

  async function onDeleteFolder(path: string, descendantDocCount: number) {
    if (descendantDocCount > 0) {
      await dialogs.alert({
        title: 'Folder not empty',
        message: `This folder has ${descendantDocCount} doc${descendantDocCount === 1 ? '' : 's'} (counting sub-folders). Move or delete them first.`
      })
      return
    }
    const ok = await dialogs.confirm({
      title: 'Delete folder',
      message: `Delete empty folder "${path}"?`,
      confirmLabel: 'Delete',
      danger: true
    })
    if (!ok) return
    try {
      await deleteFolder(path)
      if (selected.path === path) setSelected({ group: 'home', path: null })
      reload()
    } catch (err) {
      await dialogs.alert({ title: 'Delete failed', message: explain(err) })
    }
  }

  return (
    <>
      <Group justify="space-between" align="center" mb="md" gap="md" wrap="nowrap">
        <Title order={2} fz={20} fw={600} style={{ whiteSpace: 'nowrap' }}>
          Docs library
        </Title>
        <Group gap="xs">
          {isAdmin && (
            <Tooltip label="Rebuild the search index for every doc" withArrow>
              <Button
                variant="default"
                onClick={onReindexAll}
                loading={reindexing}
              >
                Reindex search
              </Button>
            </Tooltip>
          )}
          <Menu shadow="md" position="bottom-end" withinPortal>
            <Menu.Target>
              <Button>+ New doc</Button>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item onClick={() => setCreateOpen(true)}>Blank doc</Menu.Item>
              <Menu.Item onClick={() => setImportOpen(true)}>Import markdown…</Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Group>
      </Group>

      {status.kind === 'loading' && <Text c="dimmed">Loading…</Text>}

        {status.kind === 'error' && (
          <Stack gap="xs">
            <Alert color="red" variant="light" radius="sm">
              {status.message}
            </Alert>
            <Button variant="default" onClick={() => reload()} w={120}>
              Retry
            </Button>
          </Stack>
        )}

        {status.kind === 'ready' && status.docs.length === 0 && (
          <Text c="dimmed">
            No docs yet. Click <strong>+ New doc</strong> to create the first one.
          </Text>
        )}

        {status.kind === 'ready' && status.docs.length > 0 && (
          <Stack gap="sm">
            <TextInput
              placeholder="Quick filter by title, slug, creator…"
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
              size="xs"
              style={{ maxWidth: 360 }}
              aria-label="Quick filter docs"
            />
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '220px minmax(0, 1fr)',
                gap: 24,
                alignItems: 'start'
              }}
            >
              <Stack gap="sm">
                <FolderTree
                  group="home"
                  rootLabel="Home"
                  folders={homeFolders}
                  rootDocCount={homeDocs.filter((d) => !d.folder).length}
                  selected={selected}
                  onSelect={setSelected}
                  manageable
                  onRename={onRenameFolder}
                  onDelete={onDeleteFolder}
                />
                {codeDocs.length > 0 && (
                  <CodeDocsTree
                    codeDocs={codeDocs}
                    selected={selected}
                    onSelect={setSelected}
                  />
                )}
              </Stack>
              <DocsTable
                docs={status.docs}
                group={selected.group}
                folder={selected.path}
                sourceId={selected.sourceId ?? null}
                query={query}
                onOpen={(id) => nav(`/app/docs/${id}`)}
                onMove={onMoveDoc}
              />
            </div>
          </Stack>
        )}

      <BlankDocModal
        opened={createOpen}
        onClose={() => setCreateOpen(false)}
        defaultFolder={selected.group === 'home' ? selected.path : null}
      />
      <ImportDocModal opened={importOpen} onClose={() => setImportOpen(false)} />
    </>
  )
}

// ----- Folder tree sidebar -----------------------------------------------

interface TreeNode {
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
function computeFolderNodes(docs: DocSummary[]): FolderTreeNode[] {
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

function buildTree(folders: FolderTreeNode[], rootDocCount: number, rootLabel: string): TreeNode {
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

function FolderTree({
  group,
  rootLabel,
  folders,
  selected,
  onSelect,
  rootDocCount,
  manageable,
  onRename,
  onDelete
}: {
  group: FolderGroup
  rootLabel: string
  folders: FolderTreeNode[]
  selected: FolderSelection
  onSelect: (sel: FolderSelection) => void
  rootDocCount: number
  manageable: boolean
  onRename?: (path: string) => void
  onDelete?: (path: string, descendantDocCount: number) => void
}) {
  const tree = useMemo(
    () => buildTree(folders, rootDocCount, rootLabel),
    [folders, rootDocCount, rootLabel]
  )

  return (
    <aside
      style={{
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        padding: '8px 6px',
        background: 'var(--bg-surface)'
      }}
    >
      <FolderNodeRow
        node={tree}
        depth={0}
        group={group}
        selected={selected}
        onSelect={onSelect}
        manageable={manageable}
        onRename={onRename}
        onDelete={onDelete}
      />
    </aside>
  )
}

// ----- Code Docs tree (grouped by repo) ----------------------------------

interface RepoGroup {
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
function groupCodeDocsByRepo(docs: DocSummary[]): RepoGroup[] {
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

function CodeDocsTree({
  codeDocs,
  selected,
  onSelect
}: {
  codeDocs: DocSummary[]
  selected: FolderSelection
  onSelect: (sel: FolderSelection) => void
}) {
  const repos = useMemo(() => groupCodeDocsByRepo(codeDocs), [codeDocs])

  return (
    <aside
      style={{
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        padding: '8px 6px',
        background: 'var(--bg-surface)'
      }}
    >
      <Text
        fz={10}
        fw={600}
        c="dimmed"
        tt="uppercase"
        style={{ letterSpacing: '0.06em', padding: '2px 8px 6px' }}
      >
        Code Docs
      </Text>
      {repos.map((r) => (
        <FolderNodeRow
          key={r.sourceId}
          node={r.tree}
          depth={0}
          group="code"
          sourceId={r.sourceId}
          selected={selected}
          onSelect={onSelect}
          manageable={false}
        />
      ))}
    </aside>
  )
}

function FolderNodeRow({
  node,
  depth,
  group,
  sourceId,
  selected,
  onSelect,
  manageable,
  onRename,
  onDelete
}: {
  node: TreeNode
  depth: number
  group: FolderGroup
  // Repo scope for the whole subtree (code group only); undefined for home.
  sourceId?: string | null
  selected: FolderSelection
  onSelect: (sel: FolderSelection) => void
  manageable: boolean
  onRename?: (path: string) => void
  onDelete?: (path: string, descendantDocCount: number) => void
}) {
  const isActive =
    selected.group === group &&
    (selected.sourceId ?? null) === (sourceId ?? null) &&
    (node.path ?? null) === (selected.path ?? null)
  const isRoot = node.path === null

  return (
    <>
      <Group
        gap={4}
        wrap="nowrap"
        style={{
          padding: '4px 8px',
          paddingLeft: 8 + depth * 14,
          borderRadius: 4,
          cursor: 'pointer',
          background: isActive ? 'var(--bg-hover)' : undefined
        }}
        onClick={() => onSelect({ group, path: node.path, sourceId })}
      >
        <Text fz="sm" style={{ flex: 1, minWidth: 0, fontWeight: isActive || isRoot ? 600 : 400 }}>
          {node.label}
          <Text component="span" fz="xs" c="dimmed" ml={6}>
            {node.docCount}
          </Text>
        </Text>
        {manageable && !isRoot && node.path && (
          <Menu shadow="md" position="bottom-end" withinPortal>
            <Menu.Target>
              <Button
                size="compact-xs"
                variant="subtle"
                onClick={(e) => e.stopPropagation()}
                px={4}
              >
                ⋯
              </Button>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item onClick={() => node.path && onRename?.(node.path)}>Rename…</Menu.Item>
              <Menu.Item
                color="red"
                onClick={() => node.path && onDelete?.(node.path, node.descendantDocCount)}
              >
                Delete…
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        )}
      </Group>
      {node.children.map((child) => (
        <FolderNodeRow
          key={child.path ?? '/'}
          node={child}
          depth={depth + 1}
          group={group}
          sourceId={sourceId}
          selected={selected}
          onSelect={onSelect}
          manageable={manageable}
          onRename={onRename}
          onDelete={onDelete}
        />
      ))}
    </>
  )
}

// ----- Docs table --------------------------------------------------------

function DocsTable({
  docs,
  group,
  folder,
  sourceId,
  query,
  onOpen,
  onMove
}: {
  docs: DocSummary[]
  group: FolderGroup
  folder: string | null
  sourceId: string | null
  query: string
  onOpen: (id: string) => void
  onMove: (doc: DocSummary) => void
}) {
  // A non-empty query is a global "find a doc anywhere" — it searches the
  // whole library (both groups) and bypasses the folder filter. An empty
  // query is strict browse: docs of the selected group directly in the
  // selected folder (null path = that group's root). For the code group
  // the selection is also scoped to a repo (sourceId), but folder matching
  // stays exact — identical to the authored-doc browser — so the repo root
  // lists only its top-level docs, not the whole repo recursively.
  const scoped = useMemo(() => {
    if (query.trim()) return docs
    if (group === 'home') {
      return docs.filter((d) => !isGitDoc(d) && (d.folder ?? null) === folder)
    }
    return docs.filter((d) => {
      if (!isGitDoc(d)) return false
      if (sourceId && d.gitSourceId !== sourceId) return false
      return (d.folder ?? null) === folder
    })
  }, [docs, folder, sourceId, query, group])
  const filtered = useMemo(() => filterDocs(scoped, query), [scoped, query])

  const repoLabel =
    group === 'code' && sourceId
      ? (() => {
          const r = docs.find((d) => d.gitSourceId === sourceId)
          return r?.gitSourceName || r?.gitSourceSlug || 'repo'
        })()
      : null
  const where = folder ?? repoLabel ?? (group === 'code' ? 'Code Docs' : 'Home')
  if (filtered.length === 0) {
    return (
      <Text c="dimmed">
        {query ? `No docs match "${query}" across the library.` : `No docs in ${where} yet.`}
      </Text>
    )
  }
  return (
    <Stack gap={6}>
      <Text c="dimmed" fz="xs">
        {query
          ? `Showing ${filtered.length} of ${docs.length} matching "${query}" (whole library)`
          : `Showing ${filtered.length} in ${where}`}
      </Text>
      <table className="data-table">
        <thead>
          <tr>
            <th>Title</th>
            <th>Folder</th>
            <th>Created by</th>
            <th>Last edited by</th>
            <th style={{ textAlign: 'right' }}>Updated</th>
            <th style={{ width: 32 }} aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {filtered.map((d) => (
            <tr key={d.id} onClick={() => onOpen(d.id)}>
              <td>
                <Group gap={6} wrap="nowrap">
                  <span style={{ fontWeight: 500 }}>{d.title}</span>
                  {isGitDoc(d) && (
                    <Tooltip label="Synced from a git repo">
                      <Badge
                        color="grape"
                        variant="light"
                        size="xs"
                        leftSection={<span aria-hidden>⎇</span>}
                      >
                        git
                      </Badge>
                    </Tooltip>
                  )}
                  {d.lockedAt !== null && (
                    <Tooltip
                      label={`Locked${d.lockedBy ? ` by ${personLabel(d.lockedBy)}` : ''}`}
                    >
                      <Badge color="yellow" variant="light" size="xs">
                        locked
                      </Badge>
                    </Tooltip>
                  )}
                </Group>
                <div className="text-dim" style={{ fontSize: 12, marginTop: 2 }}>
                  {d.slug} · {d.kind}
                </div>
              </td>
              <td className="text-muted">
                {d.folder ? <code style={{ fontSize: 12 }}>{d.folder}</code> : '—'}
              </td>
              <td className="text-muted">{personLabel(d.createdBy)}</td>
              <td className="text-muted">{personLabel(d.updatedBy ?? d.createdBy)}</td>
              <td className="text-muted" style={{ textAlign: 'right' }}>
                {formatRelative(d.updatedAt)}
              </td>
              <td onClick={(e) => e.stopPropagation()} style={{ textAlign: 'right' }}>
                {/* Git docs are foldered by their repo path (sync-owned),
                    so "Move to folder" only applies to authored docs. */}
                {!isGitDoc(d) && (
                  <Menu shadow="md" position="bottom-end" withinPortal>
                    <Menu.Target>
                      <Button size="compact-xs" variant="subtle" px={6}>
                        ⋯
                      </Button>
                    </Menu.Target>
                    <Menu.Dropdown>
                      <Menu.Item onClick={() => onMove(d)}>Move to folder…</Menu.Item>
                    </Menu.Dropdown>
                  </Menu>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Stack>
  )
}

// ----- Blank doc modal ---------------------------------------------------

function BlankDocModal({
  opened,
  onClose,
  defaultFolder
}: {
  opened: boolean
  onClose: () => void
  defaultFolder: string | null
}) {
  const nav = useNavigate()
  const [title, setTitle] = useState('')
  const [folder, setFolder] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (opened) {
      setTitle('')
      setFolder(defaultFolder ?? '')
      setError(null)
    }
  }, [opened, defaultFolder])

  async function submit() {
    const t = title.trim()
    if (!t) return
    const f = folder.trim() || null
    setBusy(true)
    setError(null)
    try {
      const { id } = await createDoc({ title: t, folder: f })
      onClose()
      nav(`/app/docs/${id}`)
    } catch (err) {
      setError(explain(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal opened={opened} onClose={onClose} title="New doc" centered>
      <Stack gap="md">
        <TextInput
          label="Title"
          placeholder="e.g. API Guidelines"
          value={title}
          onChange={(e) => setTitle(e.currentTarget.value)}
          data-autofocus
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
        />
        <TextInput
          label="Folder"
          placeholder="/specs/api  (leave blank for root)"
          value={folder}
          onChange={(e) => setFolder(e.currentTarget.value)}
          description="Optional. Slug-shaped segments separated by /, max depth 5."
        />
        {error && (
          <Alert color="red" variant="light" radius="sm">
            {error}
          </Alert>
        )}
        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={busy} disabled={!title.trim()}>
            Create
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}

// ----- Import-markdown modal ---------------------------------------------

function ImportDocModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const nav = useNavigate()
  // Headless editor instance used only to parse markdown → blocks.
  // Created once per modal lifetime; never rendered.
  const parser = useCreateBlockNote()
  const [title, setTitle] = useState('')
  // Tracks whether the user has manually edited the title. Once they
  // have, picking a new file should NOT overwrite their choice.
  const [titleTouched, setTitleTouched] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!opened) {
      setTitle('')
      setTitleTouched(false)
      setFile(null)
      setError(null)
    }
  }, [opened])

  function onFile(f: File | null) {
    setFile(f)
    if (f && !titleTouched) {
      // Strip the common markdown extensions; leave anything else
      // (e.g. .txt, no extension) intact.
      setTitle(f.name.replace(/\.(md|mdown|markdown|mkd|mdx|txt)$/i, ''))
    }
  }

  async function submit() {
    if (!file || !title.trim()) return
    setBusy(true)
    setError(null)
    try {
      const text = await file.text()
      const blocks = parser.tryParseMarkdownToBlocks(text)
      const { id } = await createDoc({ title: title.trim() })
      try {
        await putDocContent(id, { blocks: blocks as unknown[] })
      } catch (err) {
        // Doc was created but content save failed — surface clearly.
        throw new Error(
          `Doc was created but the content upload failed: ${err instanceof Error ? err.message : String(err)}`
        )
      }
      onClose()
      nav(`/app/docs/${id}`)
    } catch (err) {
      setError(explain(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal opened={opened} onClose={onClose} title="Import markdown" centered>
      <Stack gap="md">
        <Group gap="sm" align="flex-end">
          <FileButton
            onChange={onFile}
            accept=".md,.markdown,.mdown,.mkd,.mdx,.txt,text/markdown,text/plain"
          >
            {(props) => (
              <Button variant="default" {...props}>
                {file ? 'Change file' : 'Choose file…'}
              </Button>
            )}
          </FileButton>
          <Text c={file ? undefined : 'dimmed'} fz="sm" style={{ minWidth: 0, flex: 1 }}>
            {file ? file.name : 'No file selected'}
          </Text>
        </Group>

        <TextInput
          label="Title"
          placeholder="Pick a file to autofill, or type a title"
          value={title}
          onChange={(e) => {
            setTitle(e.currentTarget.value)
            setTitleTouched(true)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
        />

        {error && (
          <Alert color="red" variant="light" radius="sm">
            {error}
          </Alert>
        )}

        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={busy} disabled={!file || !title.trim()}>
            Import
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}

// ----- helpers -----------------------------------------------------------

export function personLabel(u: UserSummary | null | undefined): string {
  if (!u) return '—'
  if (u.name && u.name.length > 0) return u.name
  const at = u.email.indexOf('@')
  return at > 0 ? u.email.slice(0, at) : u.email
}

function filterDocs(docs: DocSummary[], query: string): DocSummary[] {
  const q = query.trim().toLowerCase()
  if (!q) return docs
  return docs.filter((d) => {
    if (d.title.toLowerCase().includes(q)) return true
    if (d.slug.toLowerCase().includes(q)) return true
    if (d.kind.toLowerCase().includes(q)) return true
    const creator = personLabel(d.createdBy).toLowerCase()
    if (creator.includes(q)) return true
    const editor = personLabel(d.updatedBy ?? d.createdBy).toLowerCase()
    if (editor.includes(q)) return true
    return false
  })
}

function explain(err: unknown): string {
  if (err instanceof ApiError && err.status === 401)
    return 'Your session expired. Refresh to sign in again.'
  if (err instanceof ApiError && err.status === 413)
    return 'The markdown file is too large (max 2 MB).'
  if (err instanceof ApiError) return `Server returned HTTP ${err.status}.`
  if (err instanceof ApiSchemaError) return 'Server returned an unexpected response shape.'
  if (err instanceof Error) return err.message
  return 'Could not reach the server.'
}

function formatRelative(ts: number): string {
  const diff = Math.floor(Date.now() / 1000) - ts
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`
  return new Date(ts * 1000).toLocaleDateString()
}
