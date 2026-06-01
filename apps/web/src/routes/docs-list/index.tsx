import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Alert, Button, Group, Menu, Stack, Text, TextInput, Title, Tooltip } from '@mantine/core'
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
import { computeFolderNodes, EMPTY_DOCS, explain, type FolderSelection, isGitDoc } from './helpers'
import { ImportDocModal } from './ImportDocModal'

export { personLabel } from './helpers'

type Status =
  | { kind: 'loading' }
  | { kind: 'ready'; docs: DocSummary[] }
  | { kind: 'error'; message: string }

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
                <CodeDocsTree codeDocs={codeDocs} selected={selected} onSelect={setSelected} />
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
