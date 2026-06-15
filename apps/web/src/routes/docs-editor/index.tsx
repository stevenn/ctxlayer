import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Alert, Button, Group, Stack, Text, TextInput, Title } from '@mantine/core'
import * as Y from 'yjs'
import { useCreateBlockNote } from '@blocknote/react'
import {
  classifyHref,
  type DocContent,
  type DocDetail,
  type DocSummary,
  type GitDocStatus,
  type MeResponse
} from '@ctxlayer/shared'
import {
  ApiError,
  deleteDoc,
  fetchDoc,
  fetchDocContent,
  fetchDocGitSource,
  fetchDocGitStatus,
  fetchDocs,
  fetchMe,
  fetchRevisionContent,
  fetchRevisions,
  patchDoc,
  putDocContent,
  restoreRevision
} from '../../lib/api'
import {
  BlockNoteEditor,
  type BlockNoteEditorHandle
} from '../../components/editor/blocknote-editor'
import {
  LeaveGuard,
  SAVE_IDLE_MS,
  SaveControls,
  type SaveState
} from '../../components/editor/save-controls'
import { RevisionHistoryButton } from '../../components/editor/revision-history'
import { TagPane } from '../../components/editor/tag-pane'
import { SharingDialog } from '../docs-sharing'
import { CollabWSProvider, type CollabStatus } from '../../lib/yjs-ws-provider'
import { useDialogs } from '../../lib/dialogs'
import { DocAttachmentsRail } from './DocAttachmentsRail'
import { DocLinkPicker } from './DocLinkPicker'
import { FolderField } from './FolderField'
import { PropertyField } from './PropertyField'
import { OkfBadge } from '../../components/editor/okf-badge'
import { GitPanel } from './GitPanel'
import { explain, formatAbsolute, userColor } from './helpers'
import { LockIndicator } from './LockIndicator'
import { CollabBadge, MetaRow, Person } from './RailMeta'

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

export function DocsEditor() {
  const { id } = useParams<{ id: string }>()
  const nav = useNavigate()
  const [searchParams] = useSearchParams()
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

  // Git origin (null = ordinary doc). Drives the right-rail Git panel.
  const [gitStatus, setGitStatus] = useState<GitDocStatus | null>(null)
  // Headless BlockNote instance used only to parse a git doc's raw
  // markdown → blocks on first open (git docs store markdown, not a
  // blocks snapshot). Never rendered.
  const parser = useCreateBlockNote()

  // Initial fetch: doc detail + current REST content (used to seed Yjs
  // for docs created before M3) + current user (for awareness label).
  // For git docs with no blocks snapshot yet, parse the canonical
  // source.md into blocks here so the editor seeds from it.
  useEffect(() => {
    if (!id) return
    const ctrl = new AbortController()
    void (async () => {
      try {
        const [doc, content, me] = await Promise.all([
          fetchDoc(id, ctrl.signal),
          fetchDocContent(id, ctrl.signal),
          fetchMe(ctrl.signal)
        ])
        if (ctrl.signal.aborted) return
        let gs: GitDocStatus | null = null
        // Only probe git status for docs actually synced from a git source.
        // Authored docs have no git endpoint (it 404s by design), so skipping
        // the probe avoids a 404 on every authored-doc open.
        if (doc.gitSourceId) {
          try {
            gs = await fetchDocGitStatus(id, ctrl.signal)
          } catch (e) {
            if (!(e instanceof ApiError && e.status === 404)) {
              console.warn('git status fetch failed', e)
            }
          }
        }
        let effective = content
        if (gs && content.blocks.length === 0) {
          try {
            const { markdown } = await fetchDocGitSource(id, ctrl.signal)
            if (markdown.trim()) {
              effective = { blocks: parser.tryParseMarkdownToBlocks(markdown) as unknown[] }
            }
          } catch {
            // fall back to an empty editor
          }
        }
        if (ctrl.signal.aborted) return
        baselineRef.current = effective.blocks
        setGitStatus(gs)
        setStatus({ kind: 'ready', data: { doc, content: effective, me } })
      } catch (err) {
        if (ctrl.signal.aborted) return
        if (err instanceof ApiError && err.status === 404) {
          setStatus({ kind: 'error', message: 'This doc does not exist or was deleted.' })
          return
        }
        setStatus({ kind: 'error', message: explain(err) })
      }
    })()
    return () => ctrl.abort()
  }, [id, parser])

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
    // Subscribe to status HERE (not a separate effect) so we can unsubscribe
    // BEFORE destroy on a doc→doc switch — otherwise destroy()'s terminal
    // 'disconnected' flashes "Offline" on the badge while the next doc loads.
    const offStatus = provider.onStatus(setCollabStatus)
    return () => {
      offStatus()
      provider.destroy()
      doc.destroy()
      setCollab(null)
    }
  }, [id, userId, userLabel])

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

  // Deep-link to a section: search results link to ?section=<anchor>.
  // After collab connects + the doc renders, scroll to the matching
  // heading and flash it. Fail soft — if the heading was renamed/removed
  // (or the content hasn't synced yet) we leave the doc at the top. A few
  // staggered attempts cover the gap between 'connected' and content
  // landing; the first success wins and we don't retry on that anchor.
  const sectionScrolledRef = useRef<string | null>(null)
  const section = searchParams.get('section')
  useEffect(() => {
    if (!section || collabStatus !== 'connected') return
    if (sectionScrolledRef.current === section) return
    let done = false
    const timers = [400, 1000, 1800].map((ms) =>
      window.setTimeout(() => {
        if (done) return
        if (editorRef.current?.scrollToHeadingPath(section)) {
          done = true
          sectionScrolledRef.current = section
        }
      }, ms)
    )
    return () => timers.forEach(clearTimeout)
  }, [section, collabStatus])

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
        await putDocContent(id, { blocks }, {
          explicit: false,
          signal: AbortSignal.timeout(SAVE_TIMEOUT_MS)
        })
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
      await putDocContent(id, { blocks }, {
        explicit: true,
        signal: AbortSignal.timeout(SAVE_TIMEOUT_MS)
      })
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
    try {
      editorRef.current?.replaceBlocks(baselineRef.current)
    } catch (err) {
      // A failed revert must surface as an error, not throw — the leave
      // guard awaits this boolean and would otherwise hang open with no
      // feedback (and the inline Discard button would silently no-op).
      setSaveState({ kind: 'error', message: explain(err) })
      return false
    }
    return saveNow()
  }, [saveNow])

  // Restore: the live doc body lives in the Y.Doc (collab DO), which the
  // server-side restore does NOT touch — it only writes a new R2 revision +
  // snapshot.json. A plain reload would reseed from the stale Y.Doc and the
  // restore would be invisible (and then re-materialised over). So we push
  // the restored blocks into the live Y.Doc here via replaceBlocks: the edit
  // propagates through Yjs to the collab DO + every peer, which persists it
  // and re-materialises snapshot.json. Then advance the Discard baseline so
  // the restore isn't flagged as an unsaved change.
  const restoreFromHistory = useCallback((content: DocContent) => {
    try {
      editorRef.current?.replaceBlocks(content.blocks)
      baselineRef.current = content.blocks
      dirtyRef.current = false
      setDirty(false)
      setSaveState({ kind: 'saved' })
    } catch (err) {
      setSaveState({ kind: 'error', message: explain(err) })
    }
  }, [])

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

  const refreshGitStatus = useCallback(async () => {
    if (!id) return
    try {
      setGitStatus(await fetchDocGitStatus(id))
    } catch {
      /* keep the current status on a transient failure */
    }
  }, [id])

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

  // Click navigation for OKF doc-path links: resolve the path's slug → doc id
  // client-side. The doc list is loaded once and cached (also used by the
  // picker). External URLs never reach here (classifyHref filters them).
  const docsCacheRef = useRef<Promise<DocSummary[]> | null>(null)
  const resolveDocHref = useCallback(async (href: string): Promise<string | null> => {
    const target = classifyHref(href)
    if (!target) return null
    if (target.kind === 'id') return target.id
    if (!docsCacheRef.current) docsCacheRef.current = fetchDocs()
    const docs = await docsCacheRef.current
    return docs.find((d) => d.slug === target.slug)?.id ?? null
  }, [])

  // "Back to source": when we arrived here via a doc link the editor stashed the
  // source doc id in the route state. Look up its title from the cached doc list
  // (populated when the link was clicked — this route doesn't remount on an id
  // change, so the ref persists across the jump).
  const location = useLocation()
  const fromDocId = (location.state as { fromDocId?: string } | null)?.fromDocId ?? null
  const [fromTitle, setFromTitle] = useState<string | null>(null)
  useEffect(() => {
    const cache = docsCacheRef.current
    if (!fromDocId || fromDocId === id || !cache) {
      setFromTitle(null)
      return
    }
    let cancelled = false
    cache.then((docs) => {
      if (!cancelled) setFromTitle(docs.find((d) => d.id === fromDocId)?.title ?? null)
    })
    return () => {
      cancelled = true
    }
  }, [fromDocId, id])

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
          {fromDocId && fromDocId !== doc.id && (
            <Button
              variant="subtle"
              size="xs"
              onClick={() => nav(`/app/docs/${fromDocId}`)}
              style={{ paddingLeft: 6, paddingRight: 6, maxWidth: 220 }}
              title={fromTitle ? `Back to ${fromTitle}` : 'Back to the source doc'}
            >
              <span
                style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >
                ← {fromTitle ?? 'Back to source'}
              </span>
            </Button>
          )}
          <CollabBadge canEdit={doc.canEdit} status={collabStatus} />
        </Group>
        <Group gap="xs">
          {doc.canEdit && (
            <SaveControls state={saveState} dirty={dirty} onSave={saveNow} onDiscard={discard} />
          )}
          <LockIndicator doc={doc} onChanged={refreshDoc} />
          {/* History is hidden for git-backed docs: their source of truth is
              the upstream repo (markdown), not our R2 revision timeline. */}
          {doc.canEdit && !gitStatus && (
            <RevisionHistoryButton
              title={doc.title}
              list={() => fetchRevisions(doc.id)}
              fetchContent={(revId) => fetchRevisionContent(doc.id, revId)}
              restore={(revId) => restoreRevision(doc.id, { revisionId: revId })}
              onRestored={restoreFromHistory}
            />
          )}
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
              resolveDocHref={resolveDocHref}
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
          {gitStatus && (
            <GitPanel
              status={gitStatus}
              docId={doc.id}
              canEdit={doc.canEdit}
              getMarkdown={() => editorRef.current?.getMarkdown() ?? Promise.resolve('')}
              onRefresh={refreshGitStatus}
            />
          )}

          <div>
            <MetaRow label="Type" badge={<OkfBadge field="type" />}>
              <PropertyField
                doc={doc}
                field="docType"
                onChanged={refreshDoc}
                prompt={{
                  title: 'Set type',
                  message: 'OKF concept type, e.g. Playbook, API Endpoint, Reference.',
                  placeholder: 'Playbook'
                }}
              />
            </MetaRow>
            <MetaRow label="Description" badge={<OkfBadge field="description" />}>
              <PropertyField
                doc={doc}
                field="description"
                multiline
                onChanged={refreshDoc}
                prompt={{
                  title: 'Set description',
                  message: 'A one-sentence summary of this doc.',
                  placeholder: 'What this doc covers, in one sentence.'
                }}
              />
            </MetaRow>
            <MetaRow label="Resource" badge={<OkfBadge field="resource" />}>
              <PropertyField
                doc={doc}
                field="resource"
                onChanged={refreshDoc}
                prompt={{
                  title: 'Set resource',
                  message: 'A URI identifying the underlying asset this doc describes.',
                  placeholder: 'https://…'
                }}
              />
            </MetaRow>
            <MetaRow label="Folder">
              <FolderField doc={doc} onChanged={refreshDoc} />
            </MetaRow>
          </div>

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
            <MetaRow label="Slug">
              <code>{doc.slug}</code>
            </MetaRow>
          </div>

          <Button
            component="a"
            href={`/api/docs/${encodeURIComponent(doc.id)}/export`}
            download={`${doc.slug}.md`}
            variant="default"
            size="xs"
            fullWidth
          >
            Export as OKF (.md)
          </Button>

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
