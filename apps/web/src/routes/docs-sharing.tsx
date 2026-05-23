import { useCallback, useEffect, useRef, useState } from 'react'
import type { DocEditorsResponse, UserSearchResult } from '@ctxlayer/shared'
import {
  addDocEditor,
  fetchDocEditors,
  removeDocEditor,
  searchUsers
} from '../lib/api'

interface Props {
  docId: string
  onClose: () => void
}

export function SharingDialog({ docId, onClose }: Props) {
  const [editors, setEditors] = useState<DocEditorsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<UserSearchResult>([])

  const reload = useCallback(async (signal?: AbortSignal) => {
    try {
      const data = await fetchDocEditors(docId, signal)
      if (!signal?.aborted) setEditors(data)
    } catch (err) {
      if (signal?.aborted) return
      setError(`Could not load sharing: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [docId])

  useEffect(() => {
    const ctrl = new AbortController()
    reload(ctrl.signal)
    return () => ctrl.abort()
  }, [reload])

  // Debounced search. The server returns [] for prefixes <2 chars; we
  // still call so cleared queries reset the dropdown.
  const debouncer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (debouncer.current) clearTimeout(debouncer.current)
    debouncer.current = setTimeout(async () => {
      if (query.trim().length < 2) {
        setResults([])
        return
      }
      try {
        setResults(await searchUsers(query.trim()))
      } catch {
        setResults([])
      }
    }, 180)
    return () => {
      if (debouncer.current) clearTimeout(debouncer.current)
    }
  }, [query])

  async function grantUser(userId: string) {
    setBusy(true)
    try {
      await addDocEditor(docId, { kind: 'user', userId })
      setQuery('')
      setResults([])
      await reload()
    } finally {
      setBusy(false)
    }
  }

  async function revokeUser(userId: string) {
    setBusy(true)
    try {
      await removeDocEditor(docId, 'user', userId)
      await reload()
    } finally {
      setBusy(false)
    }
  }

  async function toggleEveryone(next: boolean) {
    setBusy(true)
    try {
      if (next) await addDocEditor(docId, { kind: 'everyone' })
      else await removeDocEditor(docId, 'everyone', '')
      await reload()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 420,
          maxWidth: 'calc(100vw - 32px)',
          background: 'var(--bg)',
          color: 'var(--fg)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          padding: 20,
          display: 'flex',
          flexDirection: 'column',
          gap: 12
        }}
      >
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <h3 style={{ margin: 0 }}>Sharing</h3>
          <button onClick={onClose}>Close</button>
        </header>

        {error && <p style={{ color: 'crimson', fontSize: 13 }}>{error}</p>}

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
          <input
            type="checkbox"
            checked={editors?.everyone ?? false}
            disabled={!editors || busy}
            onChange={(e) => toggleEveryone(e.target.checked)}
          />
          Anyone in the org can edit
        </label>

        <div>
          <p style={{ margin: '0 0 4px', fontSize: 13, color: 'var(--muted)' }}>Add by email</p>
          <input
            type="email"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="user@…"
            style={{
              width: '100%',
              padding: '6px 8px',
              borderRadius: 6,
              border: '1px solid var(--border)',
              background: 'transparent',
              color: 'inherit'
            }}
          />
          {results.length > 0 && (
            <ul style={{ listStyle: 'none', padding: 0, margin: '6px 0 0' }}>
              {results.map((u) => (
                <li
                  key={u.id}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    padding: '6px 8px',
                    borderRadius: 6,
                    border: '1px solid var(--border)',
                    marginBottom: 4
                  }}
                >
                  <span style={{ fontSize: 13 }}>
                    {u.email}
                    {u.name ? ` · ${u.name}` : ''}
                  </span>
                  <button disabled={busy} onClick={() => grantUser(u.id)}>
                    Add
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <p style={{ margin: '0 0 4px', fontSize: 13, color: 'var(--muted)' }}>Editors</p>
          {!editors && <p style={{ color: 'var(--muted)' }}>Loading…</p>}
          {editors && editors.users.length === 0 && (
            <p style={{ color: 'var(--muted)', fontSize: 13 }}>
              {editors.everyone ? 'Anyone in the org can edit this doc.' : 'No editors granted yet.'}
            </p>
          )}
          {editors && editors.users.length > 0 && (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {editors.users.map((u) => (
                <li
                  key={u.userId}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    padding: '6px 8px',
                    borderTop: '1px solid var(--border)'
                  }}
                >
                  <span style={{ fontSize: 13 }}>
                    {u.email}
                    {u.name ? ` · ${u.name}` : ''}
                  </span>
                  <button disabled={busy} onClick={() => revokeUser(u.userId)}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
