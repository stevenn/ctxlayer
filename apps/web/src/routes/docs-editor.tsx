import { useCallback, useEffect, useRef, useState } from 'react'
import { useBlocker, useNavigate, useParams } from 'react-router-dom'
import {
  Alert,
  Badge,
  Button,
  Group,
  Modal,
  Stack,
  Text,
  TextInput,
  Title
} from '@mantine/core'
import type { DocContent, DocDetail, DocSummary } from '@ctxlayer/shared'
import {
  ApiError,
  ApiSchemaError,
  deleteDoc,
  fetchDoc,
  fetchDocContent,
  fetchDocs,
  patchDoc,
  putDocContent
} from '../lib/api'
import { BlockNoteEditor } from '../components/editor/blocknote-editor'
import { SharingDialog } from './docs-sharing'

type Loaded = { doc: DocDetail; content: DocContent }
type Status =
  | { kind: 'loading' }
  | { kind: 'ready'; data: Loaded }
  | { kind: 'error'; message: string }

type LinkResolver = (link: { label: string; href: string } | null) => void

export function DocsEditor() {
  const { id } = useParams<{ id: string }>()
  const nav = useNavigate()
  const [status, setStatus] = useState<Status>({ kind: 'loading' })
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [sharingOpen, setSharingOpen] = useState(false)
  const blocksRef = useRef<unknown[]>([])

  // Inline title rename state.
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [titleSaving, setTitleSaving] = useState(false)

  // Doc-link picker state. resolver is set to a Promise resolver when
  // the user invokes the "Link to doc" slash item; closing the modal
  // (with or without a selection) calls it exactly once.
  const [linkPickerOpen, setLinkPickerOpen] = useState(false)
  const linkResolverRef = useRef<LinkResolver | null>(null)

  useEffect(() => {
    if (!id) return
    const ctrl = new AbortController()
    Promise.all([fetchDoc(id, ctrl.signal), fetchDocContent(id, ctrl.signal)]).then(
      ([doc, content]) => {
        if (ctrl.signal.aborted) return
        blocksRef.current = content.blocks
        setStatus({ kind: 'ready', data: { doc, content } })
        setDirty(false)
      },
      (err) => {
        if (ctrl.signal.aborted) return
        if (err instanceof ApiError && err.status === 404) {
          setStatus({ kind: 'error', message: 'This doc does not exist or was deleted.' })
          return
        }
        setStatus({ kind: 'error', message: explain(err) })
      }
    )
    return () => ctrl.abort()
  }, [id])

  // beforeunload: hard refresh / close-tab native prompt.
  useEffect(() => {
    if (!dirty) return
    function onBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  // In-app navigation guard. Same-doc transitions pass through.
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty && currentLocation.pathname !== nextLocation.pathname
  )

  async function onSave() {
    if (!id || status.kind !== 'ready') return
    setSaving(true)
    try {
      await putDocContent(id, { blocks: blocksRef.current })
      setDirty(false)
    } catch (err) {
      window.alert(`Save failed: ${explain(err)}`)
    } finally {
      setSaving(false)
    }
  }

  async function onDelete() {
    if (!id || status.kind !== 'ready') return
    if (!window.confirm(`Delete "${status.data.doc.title}"? This is reversible from revisions.`))
      return
    try {
      await deleteDoc(id)
      setDirty(false)
      nav('/app/docs', { replace: true })
    } catch (err) {
      window.alert(`Delete failed: ${explain(err)}`)
    }
  }

  // Title rename ---------------------------------------------------------
  function beginRename() {
    if (status.kind !== 'ready' || !status.data.doc.canEdit) return
    setTitleDraft(status.data.doc.title)
    setEditingTitle(true)
  }
  async function commitRename() {
    if (!id || status.kind !== 'ready') return
    const trimmed = titleDraft.trim()
    if (!trimmed || trimmed === status.data.doc.title) {
      setEditingTitle(false)
      return
    }
    setTitleSaving(true)
    try {
      await patchDoc(id, { title: trimmed })
      // Refetch so updatedAt / updatedBy reflect the change.
      const fresh = await fetchDoc(id)
      setStatus({ kind: 'ready', data: { doc: fresh, content: status.data.content } })
      setEditingTitle(false)
    } catch (err) {
      window.alert(`Rename failed: ${explain(err)}`)
    } finally {
      setTitleSaving(false)
    }
  }
  function cancelRename() {
    setEditingTitle(false)
  }

  // Doc-link picker ------------------------------------------------------
  const resolveDocLink = useCallback(() => {
    return new Promise<{ label: string; href: string } | null>((resolve) => {
      linkResolverRef.current = resolve
      setLinkPickerOpen(true)
    })
  }, [])
  function closeLinkPicker(pick: { label: string; href: string } | null) {
    setLinkPickerOpen(false)
    linkResolverRef.current?.(pick)
    linkResolverRef.current = null
  }

  if (status.kind === 'loading') return <Text c="dimmed">Loading…</Text>
  if (status.kind === 'error') {
    return (
      <Stack gap="md">
        <Alert color="red" variant="light" radius="sm">
          {status.message}
        </Alert>
        <Button variant="default" onClick={() => nav('/app/docs')} w={160}>
          ← Back to docs
        </Button>
      </Stack>
    )
  }

  const { doc, content } = status.data
  return (
    <Stack gap="sm" style={{ height: '100%' }}>
      {/* Action row spans full width. */}
      <Group justify="space-between" align="center" wrap="nowrap">
        <Group gap="xs">
          <Button
            variant="subtle"
            size="xs"
            onClick={() => nav('/app/docs')}
            style={{ paddingLeft: 6, paddingRight: 6 }}
          >
            ← Docs
          </Button>
          <DirtyBadge canEdit={doc.canEdit} dirty={dirty} saving={saving} />
        </Group>
        <Group gap="xs">
          {doc.canShare && (
            <Button variant="default" onClick={() => setSharingOpen(true)}>
              Sharing
            </Button>
          )}
          {doc.canEdit && (
            <Button variant="default" color="red" onClick={onDelete}>
              Delete
            </Button>
          )}
          {doc.canEdit && (
            <Button onClick={onSave} disabled={!dirty} loading={saving}>
              Save
            </Button>
          )}
        </Group>
      </Group>

      {/* Title spans full width, sits right above the content. */}
      {editingTitle ? (
        <TextInput
          value={titleDraft}
          onChange={(e) => setTitleDraft(e.currentTarget.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commitRename()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              cancelRename()
            }
          }}
          disabled={titleSaving}
          autoFocus
          size="lg"
          styles={{
            input: { fontSize: 22, fontWeight: 600, lineHeight: 1.2, padding: '6px 10px' }
          }}
        />
      ) : (
        <Title
          order={1}
          fz={22}
          fw={600}
          lh={1.2}
          onDoubleClick={beginRename}
          style={{
            cursor: doc.canEdit ? 'text' : 'default',
            padding: '6px 10px',
            marginLeft: -10,
            borderRadius: 4
          }}
          title={doc.canEdit ? 'Double-click to rename' : undefined}
        >
          {doc.title}
        </Title>
      )}

      {/* Editor + meta share a row so the meta column is flush-top
          with the editor canvas, not with the page header. */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) 240px',
          gap: 24,
          flex: 1,
          minHeight: 0,
          alignItems: 'start'
        }}
      >
        <div
          style={{
            minHeight: 400,
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            overflow: 'auto',
            background: 'var(--bg-surface)',
            height: '100%'
          }}
        >
          <BlockNoteEditor
            key={doc.id}
            initialBlocks={content.blocks}
            editable={doc.canEdit}
            onChange={(blocks) => {
              blocksRef.current = blocks
              if (!dirty) setDirty(true)
            }}
            resolveDocLink={doc.canEdit ? resolveDocLink : undefined}
          />
        </div>

        <aside
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            position: 'sticky',
            top: 0,
            color: 'var(--text-dim)',
            fontSize: 12
          }}
        >
          <MetaRow label="Created">
            <Person u={doc.createdBy} />
            <div>{formatAbsolute(doc.createdAt)}</div>
          </MetaRow>
          <MetaRow label="Last edited">
            {doc.updatedBy ? (
              <>
                <Person u={doc.updatedBy} />
                <div>{formatAbsolute(doc.updatedAt)}</div>
              </>
            ) : (
              <span>Never edited</span>
            )}
          </MetaRow>
          <MetaRow label="Slug">
            <code>{doc.slug}</code>
          </MetaRow>
          <MetaRow label="Kind">{doc.kind}</MetaRow>
        </aside>
      </div>

      {sharingOpen && doc.canShare && (
        <SharingDialog docId={doc.id} onClose={() => setSharingOpen(false)} />
      )}

      <Modal
        opened={blocker.state === 'blocked'}
        onClose={() => blocker.reset?.()}
        title="Unsaved changes"
        centered
      >
        <Stack gap="md">
          <Text>You have unsaved changes in this doc. Leave anyway?</Text>
          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={() => blocker.reset?.()}>
              Stay
            </Button>
            <Button color="red" onClick={() => blocker.proceed?.()}>
              Discard &amp; leave
            </Button>
          </Group>
        </Stack>
      </Modal>

      {linkPickerOpen && (
        <DocLinkPicker
          currentDocId={doc.id}
          onClose={() => closeLinkPicker(null)}
          onPick={(pick) => closeLinkPicker(pick)}
        />
      )}
    </Stack>
  )
}

// ----- Right-rail meta ----------------------------------------------------

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div
        style={{
          fontSize: 10,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: 'var(--text-dim)',
          marginBottom: 2
        }}
      >
        {label}
      </div>
      <div style={{ color: 'var(--text-muted)' }}>{children}</div>
    </div>
  )
}

function DirtyBadge({
  canEdit,
  dirty,
  saving
}: {
  canEdit: boolean
  dirty: boolean
  saving: boolean
}) {
  if (!canEdit) return <Badge variant="default">Read-only</Badge>
  if (saving) return <Badge color="blue">Saving…</Badge>
  if (dirty) return <Badge color="yellow">Unsaved</Badge>
  return <Badge variant="default">Saved</Badge>
}

function Person({ u }: { u: DocDetail['createdBy'] }) {
  if (!u) return <span title="user no longer exists">—</span>
  const label = u.name && u.name.length > 0 ? u.name : u.email
  return <span title={u.email}>{label}</span>
}

function formatAbsolute(ts: number): string {
  return new Date(ts * 1000).toLocaleString()
}

function explain(err: unknown): string {
  if (err instanceof ApiError && err.status === 401)
    return 'Your session expired. Refresh to sign in again.'
  if (err instanceof ApiError && err.status === 403)
    return 'You do not have permission for this action.'
  if (err instanceof ApiError) return `Server returned HTTP ${err.status}.`
  if (err instanceof ApiSchemaError) return 'Server returned an unexpected response shape.'
  return 'Could not reach the server.'
}

// ----- Doc link picker ----------------------------------------------------

interface DocLinkPickerProps {
  currentDocId: string
  onClose: () => void
  onPick: (pick: { label: string; href: string }) => void
}

function DocLinkPicker({ currentDocId, onClose, onPick }: DocLinkPickerProps) {
  const [docs, setDocs] = useState<DocSummary[] | null>(null)
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const ctrl = new AbortController()
    fetchDocs(ctrl.signal).then(
      (rows) => {
        if (!ctrl.signal.aborted) setDocs(rows.filter((d) => d.id !== currentDocId))
      },
      (err) => {
        if (!ctrl.signal.aborted) setError(explain(err))
      }
    )
    return () => ctrl.abort()
  }, [currentDocId])

  const q = query.trim().toLowerCase()
  const filtered = (docs ?? []).filter((d) =>
    q.length === 0 ? true : d.title.toLowerCase().includes(q) || d.slug.toLowerCase().includes(q)
  )

  function pickDoc(d: DocSummary) {
    // Use the doc id in the href so the link survives renames; show
    // the slug as the visible label per the design.
    onPick({ label: d.slug, href: `/app/docs/${d.id}` })
  }

  return (
    <Modal opened onClose={onClose} title="Link to doc" centered size="md">
      <Stack gap="md">
        <TextInput
          autoFocus
          placeholder="Filter by title or slug…"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && filtered[0]) {
              e.preventDefault()
              pickDoc(filtered[0])
            }
          }}
        />
        {error && (
          <Alert color="red" variant="light" radius="sm">
            {error}
          </Alert>
        )}
        {!docs && !error && <Text c="dimmed">Loading…</Text>}
        {docs && filtered.length === 0 && (
          <Text c="dimmed" fz="sm">
            No other docs match.
          </Text>
        )}
        {filtered.length > 0 && (
          <Stack gap={4} style={{ maxHeight: 360, overflowY: 'auto' }}>
            {filtered.map((d) => (
              <button
                key={d.id}
                onClick={() => pickDoc(d)}
                style={{
                  textAlign: 'left',
                  padding: '8px 10px',
                  background: 'transparent',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--text)',
                  cursor: 'pointer'
                }}
              >
                <div style={{ fontWeight: 500 }}>{d.title}</div>
                <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>{d.slug}</div>
              </button>
            ))}
          </Stack>
        )}
      </Stack>
    </Modal>
  )
}
