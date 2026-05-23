import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { DocContent, DocDetail } from '@ctxlayer/shared'
import {
  ApiError,
  ApiSchemaError,
  deleteDoc,
  fetchDoc,
  fetchDocContent,
  putDocContent
} from '../lib/api'
import { BlockNoteEditor } from '../components/editor/blocknote-editor'
import { SharingDialog } from './docs-sharing'

type Loaded = { doc: DocDetail; content: DocContent }
type Status = { kind: 'loading' } | { kind: 'ready'; data: Loaded } | { kind: 'error'; message: string }

export function DocsEditor() {
  const { id } = useParams<{ id: string }>()
  const nav = useNavigate()
  const [status, setStatus] = useState<Status>({ kind: 'loading' })
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [sharingOpen, setSharingOpen] = useState(false)
  // Latest in-memory blocks; ref so the Save handler reads the freshest
  // value without re-binding the editor's onChange every keystroke.
  const blocksRef = useRef<unknown[]>([])

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

  // Warn the user before unloading with unsaved changes. Modern
  // browsers ignore the custom string but require returnValue to be
  // set to trigger the prompt.
  useEffect(() => {
    if (!dirty) return
    function onBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  async function onSave() {
    if (!id || !status || status.kind !== 'ready') return
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
    if (!id || !status || status.kind !== 'ready') return
    if (!window.confirm(`Delete "${status.data.doc.title}"? This is reversible from revisions.`)) return
    try {
      await deleteDoc(id)
      nav('/app/docs', { replace: true })
    } catch (err) {
      window.alert(`Delete failed: ${explain(err)}`)
    }
  }

  if (status.kind === 'loading') return <p style={{ color: 'var(--muted)' }}>Loading…</p>
  if (status.kind === 'error')
    return (
      <div>
        <p style={{ color: 'crimson' }}>{status.message}</p>
        <button onClick={() => nav('/app/docs')}>← Back to docs</button>
      </div>
    )

  const { doc, content } = status.data
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%' }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 12
        }}
      >
        <div style={{ minWidth: 0 }}>
          <button onClick={() => nav('/app/docs')} style={{ marginBottom: 6 }}>
            ← Docs
          </button>
          <h2 style={{ margin: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{doc.title}</h2>
          <p style={{ color: 'var(--muted)', fontSize: 12, margin: '4px 0 0' }}>
            {doc.canEdit ? (dirty ? 'Unsaved changes' : 'Saved') : 'Read-only'}
          </p>
          <DocInfoWidget doc={doc} />
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {doc.canShare && (
            <button onClick={() => setSharingOpen(true)}>Sharing</button>
          )}
          {doc.canEdit && (
            <button onClick={onDelete} title="Soft-delete this doc">
              Delete
            </button>
          )}
          {doc.canEdit && (
            <button className="primary" onClick={onSave} disabled={!dirty || saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          )}
        </div>
      </header>

      <div
        style={{
          flex: 1,
          minHeight: 400,
          border: '1px solid var(--border)',
          borderRadius: 8,
          overflow: 'auto',
          background: 'var(--bg)'
        }}
      >
        <BlockNoteEditor
          // key by doc id so navigating to a different doc replaces
          // the editor instance (useCreateBlockNote is initial-only).
          key={doc.id}
          initialBlocks={content.blocks}
          editable={doc.canEdit}
          onChange={(blocks) => {
            blocksRef.current = blocks
            if (!dirty) setDirty(true)
          }}
        />
      </div>

      {sharingOpen && doc.canShare && (
        <SharingDialog docId={doc.id} onClose={() => setSharingOpen(false)} />
      )}
    </div>
  )
}

/**
 * Compact attribution strip: who created the doc, who saved the last
 * revision, and the matching timestamps. `updatedBy` is null for
 * never-edited docs; we surface that explicitly rather than implying
 * the creator did the edit.
 */
function DocInfoWidget({ doc }: { doc: DocDetail }) {
  return (
    <dl
      style={{
        display: 'grid',
        gridTemplateColumns: 'auto 1fr',
        columnGap: 12,
        rowGap: 2,
        margin: '8px 0 0',
        fontSize: 12,
        color: 'var(--muted)'
      }}
    >
      <dt>Created</dt>
      <dd style={{ margin: 0 }}>
        <Person u={doc.createdBy} /> · {formatAbsolute(doc.createdAt)}
      </dd>
      <dt>Last edited</dt>
      <dd style={{ margin: 0 }}>
        {doc.updatedBy ? (
          <>
            <Person u={doc.updatedBy} /> · {formatAbsolute(doc.updatedAt)}
          </>
        ) : (
          <span>Never edited</span>
        )}
      </dd>
    </dl>
  )
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
  if (err instanceof ApiError && err.status === 401) return 'Your session expired. Refresh to sign in again.'
  if (err instanceof ApiError && err.status === 403) return 'You do not have permission for this action.'
  if (err instanceof ApiError) return `Server returned HTTP ${err.status}.`
  if (err instanceof ApiSchemaError) return 'Server returned an unexpected response shape.'
  return 'Could not reach the server.'
}
