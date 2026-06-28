import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  Alert,
  Button,
  CloseButton,
  Group,
  Menu,
  Stack,
  Text,
  TextInput,
  Title,
  Tooltip
} from '@mantine/core'
import type { DocSummary } from '@ctxlayer/shared'
import {
  adminReindexAllDocs,
  deleteFolder,
  fetchDocs,
  fetchMe,
  patchDoc,
  renameFolder
} from '../../lib/api'
import { useDialogs } from '../../lib/dialogs'
import { BlankDocModal } from './BlankDocModal'
import { CodeDocsTree, FolderTree } from './FolderTree'
import { DocsTable } from './DocsTable'
import { DocPreview } from './DocPreview'
import { VerticalSplit } from './VerticalSplit'
import { computeFolderNodes, EMPTY_DOCS, explain, type FolderSelection, isGitDoc } from './helpers'

export { personLabel } from './helpers'

// ImportDocModal instantiates a headless BlockNote editor just to parse
// markdown → blocks, which would drag the whole editor stack into this
// route's chunk. Lazy-load it at the modal-open site instead so the
// chunk is only fetched when someone actually clicks "Import markdown…".
const ImportDocModal = lazy(() =>
  import('./ImportDocModal').then((m) => ({ default: m.ImportDocModal }))
)
const BundleImportModal = lazy(() =>
  import('./BundleImportModal').then((m) => ({ default: m.BundleImportModal }))
)
const BundleExportModal = lazy(() =>
  import('./BundleExportModal').then((m) => ({ default: m.BundleExportModal }))
)

type Status =
  | { kind: 'loading' }
  | { kind: 'ready'; docs: DocSummary[] }
  | { kind: 'error'; message: string }

export function DocsWorkspace() {
  const nav = useNavigate()
  // The :id segment (when present) is the doc shown in the preview pane.
  // Bare /app/docs has no id → empty preview. Opening a doc navigates to
  // /app/docs/:id (in-place preview); editing is the separate /edit route.
  const { id: previewId } = useParams<{ id: string }>()
  const dialogs = useDialogs()
  const [status, setStatus] = useState<Status>({ kind: 'loading' })
  const [createOpen, setCreateOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [bundleImportOpen, setBundleImportOpen] = useState(false)
  const [bundleExportOpen, setBundleExportOpen] = useState(false)
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

  // Centre the tree + list on the previewed doc's folder — once per id, so a
  // deep-link (or a row click from the global filter) reveals + highlights the
  // doc, but the operator's later manual folder browsing isn't snapped back.
  const syncedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!previewId) {
      syncedRef.current = null
      return
    }
    if (syncedRef.current === previewId) return
    const d = docs.find((x) => x.id === previewId)
    if (!d) return // docs not loaded yet — retry when they arrive
    syncedRef.current = previewId
    setSelected(
      isGitDoc(d)
        ? { group: 'code', path: d.folder ?? null, sourceId: d.gitSourceId ?? null }
        : { group: 'home', path: d.folder ?? null }
    )
  }, [previewId, docs])

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
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <Group justify="space-between" align="flex-start" mb="sm" gap="md" wrap="nowrap">
        <div>
          <Title order={2} fz={20} fw={600} style={{ whiteSpace: 'nowrap' }}>
            Context Library
          </Title>
          <Text c="dimmed" fz="sm">
            A collection of documentation and skills — locally managed or pulled from git sources.
          </Text>
        </div>
        <Group gap="xs">
          {isAdmin && (
            <Tooltip label="Rebuild the search index for every doc" withArrow>
              <Button variant="default" onClick={onReindexAll} loading={reindexing}>
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
              <Menu.Divider />
              <Menu.Item onClick={() => setBundleImportOpen(true)}>Import OKF bundle…</Menu.Item>
              <Menu.Item onClick={() => setBundleExportOpen(true)}>Export OKF bundle…</Menu.Item>
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
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: 'grid',
            gridTemplateColumns: '300px minmax(0, 1fr)',
            gap: 16
          }}
        >
          {/* LEFT: pinned quick-filter over the folder tree(s). The filter
              stays put; only the tree below it scrolls. */}
          <aside
            style={{ minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 8 }}
          >
            <TextInput
              placeholder="Quick filter by title, slug, creator…"
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
              size="xs"
              aria-label="Quick filter docs"
              rightSectionPointerEvents="all"
              rightSection={
                query ? (
                  <CloseButton
                    size="xs"
                    aria-label="Clear filter"
                    onClick={() => setQuery('')}
                  />
                ) : null
              }
            />
            <div style={{ minHeight: 0, overflow: 'auto' }}>
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
                  <CodeDocsTree codeDocs={codeDocs} selected={selected} onSelect={setSelected} />
                )}
              </Stack>
            </div>
          </aside>

          {/* MAIN: doc list (top, content-sized + capped) flush over the
              read-only preview (bottom, fills the rest), divided by a
              draggable handle. minHeight:0 keeps the grid min-content default
              from collapsing the independent scrolls. */}
          <VerticalSplit
            storageKey="ctxlayer.docWorkspace.listHeight"
            top={
              <DocsTable
                docs={status.docs}
                group={selected.group}
                folder={selected.path}
                sourceId={selected.sourceId ?? null}
                query={query}
                onOpen={(id) => nav(`/app/docs/${id}`)}
                onMove={onMoveDoc}
                selectedId={previewId}
              />
            }
            bottom={
              <section
                style={{
                  minHeight: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius)',
                  background: 'var(--bg-surface)',
                  overflow: 'hidden'
                }}
              >
                <DocPreview docId={previewId ?? null} />
              </section>
            }
          />
        </div>
      )}

      {createOpen && (
        <BlankDocModal
          onClose={() => setCreateOpen(false)}
          defaultFolder={selected.group === 'home' ? selected.path : null}
        />
      )}
      {importOpen && (
        <Suspense fallback={null}>
          <ImportDocModal onClose={() => setImportOpen(false)} />
        </Suspense>
      )}
      {bundleImportOpen && (
        <Suspense fallback={null}>
          <BundleImportModal
            onClose={() => setBundleImportOpen(false)}
            onImported={() => reload()}
          />
        </Suspense>
      )}
      {bundleExportOpen && (
        <Suspense fallback={null}>
          <BundleExportModal onClose={() => setBundleExportOpen(false)} />
        </Suspense>
      )}
    </div>
  )
}
