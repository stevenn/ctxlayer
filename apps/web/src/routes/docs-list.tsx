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
  createDoc,
  deleteFolder,
  fetchDocs,
  fetchFolders,
  patchDoc,
  putDocContent,
  renameFolder
} from '../lib/api'
import { useDialogs } from '../lib/dialogs'
import { DocSearch } from '../components/search/doc-search'

type Status =
  | { kind: 'loading' }
  | { kind: 'ready'; docs: DocSummary[]; folders: FolderTreeNode[] }
  | { kind: 'error'; message: string }

export function DocsList() {
  const nav = useNavigate()
  const dialogs = useDialogs()
  const [status, setStatus] = useState<Status>({ kind: 'loading' })
  const [createOpen, setCreateOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  // Client-side filter over the list. Title / slug / creator / kind /
  // folder are all matched case-insensitively. RAG search lives behind
  // MCP (`search_docs`) — this bar is for "find a doc I know exists".
  const [query, setQuery] = useState('')
  // Selected folder filters the visible doc list. null = "All docs"
  // (everything visible). The tree shows folder counts so users can
  // see how many docs are under each folder before clicking in.
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null)

  const reload = useCallback((signal?: AbortSignal) => {
    setStatus({ kind: 'loading' })
    Promise.all([fetchDocs(signal), fetchFolders(signal)]).then(
      ([docs, ft]) => {
        if (!signal?.aborted) setStatus({ kind: 'ready', docs, folders: ft.folders })
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
      if (selectedFolder?.startsWith(oldPath)) {
        setSelectedFolder(next + selectedFolder.slice(oldPath.length))
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
      if (selectedFolder === path) setSelectedFolder(null)
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

      {/* Semantic search is the hero. When idle it renders the browse
          view (folder tree + table) passed as children; running a search
          replaces it with ranked, deep-linked results. */}
      <DocSearch>
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
              <FolderTree
                folders={status.folders}
                selected={selectedFolder}
                onSelect={setSelectedFolder}
                rootDocCount={status.docs.filter((d) => !d.folder).length}
                onRename={onRenameFolder}
                onDelete={onDeleteFolder}
              />
              <DocsTable
                docs={status.docs}
                folder={selectedFolder}
                query={query}
                onOpen={(id) => nav(`/app/docs/${id}`)}
                onMove={onMoveDoc}
              />
            </div>
          </Stack>
        )}
      </DocSearch>

      <BlankDocModal
        opened={createOpen}
        onClose={() => setCreateOpen(false)}
        defaultFolder={selectedFolder}
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
function buildTree(folders: FolderTreeNode[], rootDocCount: number): TreeNode {
  const root: TreeNode = {
    label: 'Root',
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
  folders,
  selected,
  onSelect,
  rootDocCount,
  onRename,
  onDelete
}: {
  folders: FolderTreeNode[]
  selected: string | null
  onSelect: (path: string | null) => void
  rootDocCount: number
  onRename: (path: string) => void
  onDelete: (path: string, descendantDocCount: number) => void
}) {
  const tree = useMemo(() => buildTree(folders, rootDocCount), [folders, rootDocCount])

  return (
    <aside
      style={{
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        padding: '8px 6px',
        background: 'var(--bg-surface)'
      }}
    >
      <div
        style={{
          fontSize: 10,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: 'var(--text-dim)',
          padding: '4px 8px 8px'
        }}
      >
        Folders
      </div>
      <FolderNodeRow
        node={tree}
        depth={0}
        selected={selected}
        onSelect={onSelect}
        onRename={onRename}
        onDelete={onDelete}
      />
    </aside>
  )
}

function FolderNodeRow({
  node,
  depth,
  selected,
  onSelect,
  onRename,
  onDelete
}: {
  node: TreeNode
  depth: number
  selected: string | null
  onSelect: (path: string | null) => void
  onRename: (path: string) => void
  onDelete: (path: string, descendantDocCount: number) => void
}) {
  const isActive = node.path === selected || (node.path === null && selected === null)
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
        onClick={() => onSelect(node.path)}
      >
        <Text fz="sm" style={{ flex: 1, minWidth: 0, fontWeight: isActive ? 600 : 400 }}>
          {node.label}
          <Text component="span" fz="xs" c="dimmed" ml={6}>
            {node.docCount}
          </Text>
        </Text>
        {!isRoot && node.path && (
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
              <Menu.Item onClick={() => node.path && onRename(node.path)}>
                Rename…
              </Menu.Item>
              <Menu.Item
                color="red"
                onClick={() => node.path && onDelete(node.path, node.descendantDocCount)}
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
          selected={selected}
          onSelect={onSelect}
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
  folder,
  query,
  onOpen,
  onMove
}: {
  docs: DocSummary[]
  folder: string | null
  query: string
  onOpen: (id: string) => void
  onMove: (doc: DocSummary) => void
}) {
  // A non-empty query is a global "find a doc anywhere" — it bypasses
  // the folder filter so the user doesn't have to remember which folder
  // a doc lives in. An empty query falls back to strict folder browse:
  // only docs directly in the selected folder (null = Root).
  const scoped = useMemo(() => {
    if (query.trim()) return docs
    return docs.filter((d) => (d.folder ?? null) === folder)
  }, [docs, folder, query])
  const filtered = useMemo(() => filterDocs(scoped, query), [scoped, query])

  if (filtered.length === 0) {
    const where = folder ?? 'Root'
    return (
      <Text c="dimmed">
        {query
          ? `No docs match "${query}" across the library.`
          : `No docs in ${where} yet.`}
      </Text>
    )
  }
  return (
    <Stack gap={6}>
      <Text c="dimmed" fz="xs">
        {query
          ? `Showing ${filtered.length} of ${docs.length} matching "${query}" (all folders)`
          : `Showing ${filtered.length} in ${folder ?? 'Root'}`}
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
