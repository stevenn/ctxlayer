import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Group,
  Modal,
  Stack,
  Text,
  TextInput,
  Title,
  Tooltip
} from '@mantine/core'
import * as Y from 'yjs'
import type {
  DocAttachmentRef,
  DocContent,
  DocDetail,
  DocSummary,
  MeResponse,
  UserUpstreamSummary
} from '@ctxlayer/shared'
import {
  ApiError,
  ApiSchemaError,
  attachDoc,
  deleteDoc,
  detachDoc,
  fetchDoc,
  fetchDocAttachments,
  fetchDocContent,
  fetchDocs,
  fetchMe,
  fetchUpstreams,
  fetchUserUpstreamTools,
  patchDoc,
  putDocContent,
  setDocLocked
} from '../lib/api'
import {
  BlockNoteEditor,
  type BlockNoteEditorHandle
} from '../components/editor/blocknote-editor'
import {
  LeaveGuard,
  SAVE_IDLE_MS,
  SaveControls,
  type SaveState
} from '../components/editor/save-controls'
import { TagPane } from '../components/editor/tag-pane'
import { SharingDialog } from './docs-sharing'
import { CollabWSProvider, type CollabStatus } from '../lib/yjs-ws-provider'
import { useDialogs } from '../lib/dialogs'
import { personLabel } from './docs-list'

type Loaded = { doc: DocDetail; content: DocContent; me: MeResponse }
type LoadStatus =
  | { kind: 'loading' }
  | { kind: 'ready'; data: Loaded }
  | { kind: 'error'; message: string }

type LinkResolver = (link: { label: string; href: string } | null) => void

const COLLAB_FRAGMENT = 'document-store'

// Idle debounce is shared with the skill editor (SAVE_IDLE_MS). The
// max-coalesce window is doc-specific — it caps how long continuous typing
// can defer a REST revision, matched to the DO's Yjs-snapshot cadence.
const SAVE_MAX_MS = 30_000
// Hard ceiling on a single autosave/save request. Without it a hung
// connection wedges the autosave's in-flight guard forever (the bug
// behind "autosave not working reliably"). On abort we surface an error.
const SAVE_TIMEOUT_MS = 15_000

// Stable per-user cursor color. HSL hue derived from a fast 32-bit
// hash of the userId, full saturation, mid lightness.
function userColor(userId: string): string {
  let h = 0
  for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) | 0
  const hue = ((h % 360) + 360) % 360
  return `hsl(${hue}, 70%, 50%)`
}

export function DocsEditor() {
  const { id } = useParams<{ id: string }>()
  const nav = useNavigate()
  const dialogs = useDialogs()
  const [status, setStatus] = useState<LoadStatus>({ kind: 'loading' })
  const [collabStatus, setCollabStatus] = useState<CollabStatus>('connecting')
  const [sharingOpen, setSharingOpen] = useState(false)

  // Explicit-save state. `dirty` = edited since the last Save click (or
  // since open); it drives the badge + the navigation guard. Autosave
  // persists in the background but does NOT clear this — only an explicit
  // Save (or Discard) does. `baselineRef` holds the content Discard
  // reverts to.
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' })
  const [dirty, setDirty] = useState(false)
  const dirtyRef = useRef(false)
  const baselineRef = useRef<unknown[]>([])
  // True only while we programmatically reseed the editor (legacy
  // migration), so those synthetic Y.Doc updates don't mark the doc dirty.
  const seedingRef = useRef(false)

  // Inline title rename state.
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [titleSaving, setTitleSaving] = useState(false)

  // Doc-link picker state. resolver is set to a Promise resolver when
  // the user invokes the "Link to doc" slash item; closing the modal
  // (with or without a selection) calls it exactly once.
  const [linkPickerOpen, setLinkPickerOpen] = useState(false)
  const linkResolverRef = useRef<LinkResolver | null>(null)

  // Yjs + provider live for the lifetime of one (doc, user) pair.
  // Construction lives in the effect below — NOT useMemo — so a
  // StrictMode synthetic unmount/remount cleanly destroys + recreates
  // the provider instead of leaving the React tree pointing at a
  // dead WebSocket.
  type CollabBundle = {
    doc: Y.Doc
    provider: CollabWSProvider
    fragment: Y.XmlFragment
    user: { name: string; color: string }
  }
  const [collab, setCollab] = useState<CollabBundle | null>(null)
  const editorRef = useRef<BlockNoteEditorHandle | null>(null)

  // Initial fetch: doc detail + current REST content (used to seed Yjs
  // for docs created before M3) + current user (for awareness label).
  useEffect(() => {
    if (!id) return
    const ctrl = new AbortController()
    Promise.all([
      fetchDoc(id, ctrl.signal),
      fetchDocContent(id, ctrl.signal),
      fetchMe(ctrl.signal)
    ]).then(
      ([doc, content, me]) => {
        if (ctrl.signal.aborted) return
        baselineRef.current = content.blocks
        setStatus({ kind: 'ready', data: { doc, content, me } })
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

  // Build Y.Doc + provider once we know the doc + user. Owning
  // construction inside the effect (rather than useMemo) guarantees
  // mount → create, unmount → destroy, and is StrictMode-safe (the
  // synthetic double-mount destroys A then constructs B cleanly).
  // The effect intentionally depends only on (id, user.id) — title
  // renames refetch DocDetail but should not tear down the live
  // collab session.
  const userId = status.kind === 'ready' ? status.data.me.id : null
  const userLabel =
    status.kind === 'ready'
      ? status.data.me.name && status.data.me.name.length > 0
        ? status.data.me.name
        : status.data.me.email
      : null
  useEffect(() => {
    if (!id || !userId || !userLabel) return
    const doc = new Y.Doc()
    const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = `${wsProto}//${window.location.host}/collab/${encodeURIComponent(id)}`
    const provider = new CollabWSProvider(url, doc)
    const color = userColor(userId)
    provider.awareness.setLocalState({
      user: { id: userId, name: userLabel, color }
    })
    setCollab({
      doc,
      provider,
      fragment: doc.getXmlFragment(COLLAB_FRAGMENT),
      user: { name: userLabel, color }
    })
    return () => {
      provider.destroy()
      doc.destroy()
      setCollab(null)
    }
  }, [id, userId, userLabel])

  // Track provider status so the badge stays in sync. The provider
  // calls back synchronously with the current status on subscribe.
  useEffect(() => {
    const provider = collab?.provider
    if (!provider) return
    return provider.onStatus(setCollabStatus)
  }, [collab])

  // Seed migration: if the Y.Doc fragment is still empty after the
  // first 'connected' status AND we have legacy JSON content AND
  // we're the awareness leader (lowest clientID), replace blocks with
  // the JSON. Subsequent opens won't trigger this because the DO will
  // have persisted the seeded state to yjs/snapshot.bin.
  const seededRef = useRef(false)
  useEffect(() => {
    if (collabStatus !== 'connected' || seededRef.current) return
    if (status.kind !== 'ready' || !collab) return
    if (!status.data.doc.canEdit) {
      // Read-only viewers must not write seeds.
      seededRef.current = true
      return
    }
    const blocks = status.data.content.blocks
    if (blocks.length === 0) {
      seededRef.current = true
      return
    }
    // Defer one tick so the initial syncStep2 from the server has a
    // chance to land — otherwise we might seed on top of a non-empty
    // doc that just hasn't been applied yet.
    const t = window.setTimeout(() => {
      seededRef.current = true
      const fragment = collab.fragment
      if (fragment.length > 0) return
      const localID = collab.doc.clientID
      const ids = [...collab.provider.awareness.getStates().keys()]
      if (ids.length > 0 && Math.min(...ids) !== localID) return
      // Seeding is not a user edit — suppress dirty marking around it.
      seedingRef.current = true
      editorRef.current?.replaceBlocks(blocks)
      baselineRef.current = blocks
      seedingRef.current = false
    }, 400)
    return () => clearTimeout(t)
  }, [collabStatus, collab, status])

  // Autosave: any local Y.Doc update kicks the debounce. The save
  // call is gated on awareness-leader election so concurrent tabs
  // share a single revision per save window.
  useEffect(() => {
    if (!id || !collab || status.kind !== 'ready') return
    if (!status.data.doc.canEdit) return
    const { doc, provider } = collab
    let idleTimer: number | null = null
    let maxTimer: number | null = null
    let dirty = false
    let inFlight = false

    const save = async () => {
      if (idleTimer != null) {
        clearTimeout(idleTimer)
        idleTimer = null
      }
      if (maxTimer != null) {
        clearTimeout(maxTimer)
        maxTimer = null
      }
      if (!dirty || inFlight) return
      const localID = doc.clientID
      const ids = [...provider.awareness.getStates().keys()]
      // If we're the only known client we're trivially leader. Otherwise
      // lowest-clientID wins; deterministic and zero-coordination.
      const isLeader = ids.length === 0 || Math.min(...ids) === localID
      if (!isLeader) {
        dirty = false
        return
      }
      const blocks = editorRef.current?.getBlocks() ?? []
      dirty = false
      inFlight = true
      try {
        await putDocContent(id, { blocks }, AbortSignal.timeout(SAVE_TIMEOUT_MS))
        // Autosave persisted. Surface it as "autosaved" WITHOUT clearing
        // the user-facing dirty state — the nav guard stays armed until an
        // explicit Save. Skip if the user already saved in the meantime.
        if (dirtyRef.current) setSaveState({ kind: 'autosaved' })
      } catch (err) {
        // Re-mark dirty so the next change triggers another attempt, and
        // surface the failure instead of swallowing it in the console.
        dirty = true
        setSaveState({ kind: 'error', message: explain(err) })
        console.error('collab autosave failed', err)
      } finally {
        inFlight = false
      }
    }

    const onUpdate = (_update: Uint8Array, origin: unknown) => {
      if (origin === provider) return // remote update; the leader on the originating tab will save
      dirty = true
      if (idleTimer != null) clearTimeout(idleTimer)
      idleTimer = window.setTimeout(save, SAVE_IDLE_MS)
      if (maxTimer == null) maxTimer = window.setTimeout(save, SAVE_MAX_MS)
      // Mark the user-facing unsaved state. It stays set (nav guard armed)
      // until an explicit Save/Discard; autosave only flips the badge to
      // "autosaved". Dedupe via functional update so we don't re-render on
      // every keystroke once already showing "unsaved".
      if (seedingRef.current) return
      dirtyRef.current = true
      setDirty(true)
      setSaveState((prev) => (prev.kind === 'dirty' ? prev : { kind: 'dirty' }))
    }

    // Flush on tab hide/close too — a React unmount covers in-app
    // navigation, but pagehide/visibilitychange cover closing or
    // refreshing the tab, where the debounce would otherwise be lost.
    // (The server DO also reconciles snapshot.json from the Y.Doc, so
    // this is belt-and-suspenders — it keeps the explicit revision +
    // search reindex current rather than waiting for the next edit.)
    const flushOnHide = () => {
      if (dirty && !inFlight) void save()
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flushOnHide()
    }
    window.addEventListener('pagehide', flushOnHide)
    document.addEventListener('visibilitychange', onVisibility)

    doc.on('update', onUpdate)
    return () => {
      doc.off('update', onUpdate)
      window.removeEventListener('pagehide', flushOnHide)
      document.removeEventListener('visibilitychange', onVisibility)
      if (idleTimer) clearTimeout(idleTimer)
      if (maxTimer) clearTimeout(maxTimer)
      // Best-effort final save so the last keystroke isn't lost.
      if (dirty && !inFlight) void save()
    }
  }, [collab, id, status])

  // Explicit Save — runs on this tab regardless of leader election (the
  // user clicked Save here). Advances the Discard baseline on success.
  const saveNow = useCallback(async (): Promise<boolean> => {
    if (!id || !editorRef.current) return false
    const blocks = editorRef.current.getBlocks()
    setSaveState({ kind: 'saving' })
    try {
      await putDocContent(id, { blocks }, AbortSignal.timeout(SAVE_TIMEOUT_MS))
      baselineRef.current = blocks
      dirtyRef.current = false
      setDirty(false)
      setSaveState({ kind: 'saved' })
      return true
    } catch (err) {
      setSaveState({ kind: 'error', message: explain(err) })
      return false
    }
  }, [id])

  // Discard — revert the editor to the baseline. replaceBlocks emits Yjs
  // updates, so the revert propagates to every collaborator in the room;
  // the follow-up save persists it as the new current revision.
  const discard = useCallback(async (): Promise<boolean> => {
    editorRef.current?.replaceBlocks(baselineRef.current)
    return saveNow()
  }, [saveNow])

  async function onDelete() {
    if (!id || status.kind !== 'ready') return
    const ok = await dialogs.confirm({
      title: 'Delete doc',
      message: `Delete "${status.data.doc.title}"? This is reversible from revisions.`,
      confirmLabel: 'Delete',
      danger: true
    })
    if (!ok) return
    try {
      await deleteDoc(id)
      // Deleting supersedes any unsaved edits — drop the guard before nav.
      dirtyRef.current = false
      setDirty(false)
      nav('/app/docs', { replace: true })
    } catch (err) {
      await dialogs.alert({ title: 'Delete failed', message: explain(err) })
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
      const fresh = await fetchDoc(id)
      setStatus({
        kind: 'ready',
        data: { ...status.data, doc: fresh }
      })
      setEditingTitle(false)
    } catch (err) {
      await dialogs.alert({ title: 'Rename failed', message: explain(err) })
    } finally {
      setTitleSaving(false)
    }
  }
  function cancelRename() {
    setEditingTitle(false)
  }

  // Re-pull the doc detail after a side-channel mutation (lock toggle,
  // folder move, etc.) so the rail + header reflect the new state.
  async function refreshDoc() {
    if (!id || status.kind !== 'ready') return
    const fresh = await fetchDoc(id)
    setStatus({ kind: 'ready', data: { ...status.data, doc: fresh } })
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

  const { doc, me } = status.data
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
          <CollabBadge canEdit={doc.canEdit} status={collabStatus} />
        </Group>
        <Group gap="xs">
          {doc.canEdit && (
            <SaveControls
              state={saveState}
              dirty={dirty}
              onSave={saveNow}
              onDiscard={discard}
            />
          )}
          <LockIndicator doc={doc} onChanged={refreshDoc} />
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
          {collab && (
            <BlockNoteEditor
              key={doc.id}
              ref={editorRef}
              initialBlocks={[]}
              editable={doc.canEdit}
              collaboration={{
                provider: collab.provider,
                fragment: collab.fragment,
                user: collab.user
              }}
              resolveDocLink={doc.canEdit ? resolveDocLink : undefined}
            />
          )}
        </div>

        <aside
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
            position: 'sticky',
            top: 0,
            color: 'var(--text-dim)',
            fontSize: 12
          }}
        >
          <TagPane docId={doc.id} canEdit={doc.canEdit} />

          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
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
            <MetaRow label="Folder">
              <FolderField doc={doc} onChanged={refreshDoc} />
            </MetaRow>
            <MetaRow label="Slug">
              <code>{doc.slug}</code>
            </MetaRow>
            <MetaRow label="Kind">{doc.kind}</MetaRow>
          </div>

          <DocAttachmentsRail docId={doc.id} canManage={!!me?.role && me.role === 'admin'} />
        </aside>
      </div>

      {sharingOpen && doc.canShare && (
        <SharingDialog docId={doc.id} onClose={() => setSharingOpen(false)} />
      )}

      {linkPickerOpen && (
        <DocLinkPicker
          currentDocId={doc.id}
          onClose={() => closeLinkPicker(null)}
          onPick={(pick) => closeLinkPicker(pick)}
        />
      )}

      <LeaveGuard dirty={dirty} onSave={saveNow} onDiscard={discard} />
    </Stack>
  )
}

// ----- Lock indicator -----------------------------------------------------

/**
 * Padlock in the header. Renders for everyone when the doc is locked
 * (so viewers see *why* the editor is read-only via the tooltip) and for
 * lock-capable users when the doc is unlocked (so they can lock it).
 * Clicking is a no-op for users without canLock — they just get the
 * tooltip explaining the locked state. Locking asks for confirmation so
 * an accidental click doesn't freeze everyone mid-edit.
 */
function LockIndicator({
  doc,
  onChanged
}: {
  doc: DocDetail
  onChanged: () => Promise<void>
}) {
  const dialogs = useDialogs()
  const [busy, setBusy] = useState(false)
  const locked = !!doc.lockedAt

  if (!locked && !doc.canLock) return null

  async function toggle() {
    if (busy || !doc.canLock) return
    if (!locked) {
      const ok = await dialogs.confirm({
        title: 'Lock doc',
        message: `Lock "${doc.title}"? Content, title, and tags become read-only for everyone (including you) until you unlock.`,
        confirmLabel: 'Lock'
      })
      if (!ok) return
    }
    setBusy(true)
    try {
      await setDocLocked(doc.id, { locked: !locked })
      await onChanged()
    } catch (err) {
      await dialogs.alert({
        title: `${locked ? 'Unlock' : 'Lock'} failed`,
        message: explain(err)
      })
    } finally {
      setBusy(false)
    }
  }

  const tooltipLabel = locked
    ? `Locked by ${personLabel(doc.lockedBy)} on ${formatAbsolute(doc.lockedAt!)} — ${
        doc.canLock ? 'click to unlock' : 'an admin or the creator can unlock'
      }`
    : 'Lock this doc — content, title, and tags become read-only until unlocked'

  return (
    <Tooltip label={tooltipLabel} withArrow multiline maw={280}>
      <ActionIcon
        variant={locked ? 'light' : 'subtle'}
        color={locked ? 'yellow' : 'gray'}
        size="lg"
        onClick={toggle}
        loading={busy}
        style={{ cursor: doc.canLock ? 'pointer' : 'default' }}
        aria-label={locked ? 'Locked' : 'Unlocked'}
      >
        {locked ? <PadlockClosedIcon /> : <PadlockOpenIcon />}
      </ActionIcon>
    </Tooltip>
  )
}

function PadlockClosedIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  )
}

function PadlockOpenIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 7.5-2" />
    </svg>
  )
}

// ----- Folder field (right-rail) -----------------------------------------

/**
 * Click-to-move folder cell. Read-only viewers see just the path. Editors
 * see a clickable cell that pops a prompt for the new path; empty string
 * moves the doc back to Root. Backend validates the path shape (same
 * FolderPath schema used at create time) and returns a 4xx on bad input,
 * which we surface as an alert.
 */
function FolderField({
  doc,
  onChanged
}: {
  doc: DocDetail
  onChanged: () => Promise<void>
}) {
  const dialogs = useDialogs()
  const [busy, setBusy] = useState(false)
  const current = doc.folder

  async function move() {
    if (busy || !doc.canEdit) return
    const next = await dialogs.prompt({
      title: 'Move doc',
      message: 'Enter a folder path (e.g. /specs/api) or leave blank for Root.',
      defaultValue: current ?? '',
      placeholder: '/specs/api',
      confirmLabel: 'Move'
    })
    if (next === null) return
    const target = next.trim() === '' ? null : next.trim()
    if (target === current) return
    setBusy(true)
    try {
      await patchDoc(doc.id, { folder: target })
      await onChanged()
    } catch (err) {
      await dialogs.alert({ title: 'Move failed', message: explain(err) })
    } finally {
      setBusy(false)
    }
  }

  const label = current ? <code>{current}</code> : <span>Root</span>

  if (!doc.canEdit) return <div>{label}</div>

  return (
    <div
      onClick={move}
      style={{
        cursor: busy ? 'progress' : 'pointer',
        opacity: busy ? 0.6 : 1,
        textDecoration: 'underline',
        textDecorationStyle: 'dotted',
        textUnderlineOffset: 3
      }}
      title="Click to move"
    >
      {label}
    </div>
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

function CollabBadge({ canEdit, status }: { canEdit: boolean; status: CollabStatus }) {
  if (!canEdit) return <Badge variant="default">Read-only</Badge>
  switch (status) {
    case 'connected':
      return <Badge color="green">Live</Badge>
    case 'connecting':
      return <Badge color="blue">Connecting…</Badge>
    case 'reconnecting':
      return <Badge color="yellow">Reconnecting…</Badge>
    case 'disconnected':
      return <Badge color="red">Offline</Badge>
  }
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

// ----- DocAttachmentsRail (M7a) -----------------------------------------

/**
 * Right-rail section showing which upstreams (and optionally which
 * specific tool on those upstreams) this doc is attached to. Reads
 * are open; mutations require admin (canManage).
 */
function DocAttachmentsRail({ docId, canManage }: { docId: string; canManage: boolean }) {
  const dialogs = useDialogs()
  const [items, setItems] = useState<DocAttachmentRef[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attachOpen, setAttachOpen] = useState(false)

  const reload = useCallback(async () => {
    try {
      const rows = await fetchDocAttachments(docId)
      setItems(rows)
    } catch (err) {
      setError(explain(err))
    }
  }, [docId])

  useEffect(() => {
    void reload()
  }, [reload])

  async function onDetach(a: DocAttachmentRef) {
    const ok = await dialogs.confirm({
      title: 'Detach from upstream?',
      message: `Remove the attachment to ${a.upstreamSlug}${a.toolName ? `.${a.toolName}` : ''}?`,
      confirmLabel: 'Detach',
      danger: true
    })
    if (!ok) return
    try {
      await detachDoc({
        docId,
        upstreamId: a.upstreamId,
        toolName: a.toolName || undefined
      })
      await reload()
    } catch (err) {
      await dialogs.alert({ title: 'Detach failed', message: explain(err) })
    }
  }

  return (
    <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
      <div
        style={{
          fontSize: 10,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: 'var(--text-dim)',
          marginBottom: 6
        }}
      >
        Attached to upstreams
      </div>
      {error && (
        <Text fz="xs" c="red">
          {error}
        </Text>
      )}
      {items === null && !error && (
        <Text fz="xs" c="dimmed">
          Loading…
        </Text>
      )}
      {items && items.length === 0 && (
        <Text fz="xs" c="dimmed">
          Not attached to any upstream.
        </Text>
      )}
      {items && items.length > 0 && (
        <Stack gap={4}>
          {items.map((a) => (
            <Group
              key={`${a.upstreamId}/${a.toolName}`}
              justify="space-between"
              gap="xs"
              wrap="nowrap"
              style={{
                padding: '4px 6px',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)'
              }}
            >
              <Text fz="xs" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                <code>{a.upstreamSlug}</code>
                {a.toolName ? (
                  <>
                    {' · '}
                    <code>{a.toolName}</code>
                  </>
                ) : (
                  <span style={{ color: 'var(--text-dim)' }}> (whole upstream)</span>
                )}
              </Text>
              {canManage && (
                <Button size="xs" variant="subtle" color="red" onClick={() => void onDetach(a)}>
                  ×
                </Button>
              )}
            </Group>
          ))}
        </Stack>
      )}
      {canManage && (
        <Group justify="flex-end" mt="xs">
          <Button size="xs" variant="default" onClick={() => setAttachOpen(true)}>
            Attach to upstream
          </Button>
        </Group>
      )}
      {attachOpen && (
        <DocAttachToUpstreamModal
          docId={docId}
          onClose={() => setAttachOpen(false)}
          onAttached={async () => {
            setAttachOpen(false)
            await reload()
          }}
        />
      )}
    </div>
  )
}

function DocAttachToUpstreamModal({
  docId,
  onClose,
  onAttached
}: {
  docId: string
  onClose: () => void
  onAttached: () => void
}) {
  const [upstreams, setUpstreams] = useState<UserUpstreamSummary[] | null>(null)
  const [selectedUpstreamId, setSelectedUpstreamId] = useState<string | null>(null)
  const [tools, setTools] = useState<{ value: string; label: string }[]>([])
  const [selectedTool, setSelectedTool] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchUpstreams()
      .then((rows) => !cancelled && setUpstreams(rows))
      .catch((err) => !cancelled && setError(explain(err)))
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!selectedUpstreamId) {
      setTools([])
      setSelectedTool('')
      return
    }
    let cancelled = false
    fetchUserUpstreamTools(selectedUpstreamId)
      .then((resp) => {
        if (cancelled) return
        setTools([
          { value: '', label: '— whole upstream —' },
          ...resp.tools.map((t) => ({ value: t.toolName, label: t.toolName }))
        ])
        setSelectedTool('')
      })
      .catch((err) => !cancelled && setError(explain(err)))
    return () => {
      cancelled = true
    }
  }, [selectedUpstreamId])

  async function submit() {
    if (!selectedUpstreamId) return
    setBusy(true)
    setError(null)
    try {
      await attachDoc({
        docId,
        upstreamId: selectedUpstreamId,
        toolName: selectedTool || undefined
      })
      onAttached()
    } catch (err) {
      setError(explain(err))
    } finally {
      setBusy(false)
    }
  }

  const upstreamOptions = (upstreams ?? []).map((u) => ({
    value: u.id,
    label: `${u.displayName} (${u.slug})`
  }))

  return (
    <Modal opened onClose={onClose} title="Attach doc to upstream" size="md">
      <Stack gap="md">
        {error && (
          <Text fz="sm" c="red">
            {error}
          </Text>
        )}
        <select
          value={selectedUpstreamId ?? ''}
          onChange={(e) => setSelectedUpstreamId(e.currentTarget.value || null)}
          disabled={!upstreams || busy}
          style={{ padding: 6 }}
        >
          <option value="">Pick an upstream…</option>
          {upstreamOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <select
          value={selectedTool}
          onChange={(e) => setSelectedTool(e.currentTarget.value)}
          disabled={!selectedUpstreamId || busy}
          style={{ padding: 6 }}
        >
          {tools.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} loading={busy} disabled={!selectedUpstreamId}>
            Attach
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}
