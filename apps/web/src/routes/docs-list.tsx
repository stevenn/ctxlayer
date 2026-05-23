import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { DocSummary, UserSummary } from '@ctxlayer/shared'
import { ApiError, ApiSchemaError, createDoc, fetchDocs } from '../lib/api'

type Status =
  | { kind: 'loading' }
  | { kind: 'ready'; docs: DocSummary[] }
  | { kind: 'error'; message: string }

export function DocsList() {
  const nav = useNavigate()
  const [status, setStatus] = useState<Status>({ kind: 'loading' })
  const [creating, setCreating] = useState(false)

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

  async function onCreate() {
    const title = window.prompt('Title for the new doc:')?.trim()
    if (!title) return
    setCreating(true)
    try {
      const { id } = await createDoc({ title })
      nav(`/app/docs/${id}`)
    } catch (err) {
      window.alert(`Could not create doc: ${explain(err)}`)
    } finally {
      setCreating(false)
    }
  }

  return (
    <div>
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          marginBottom: 16
        }}
      >
        <h2 style={{ margin: 0 }}>Docs library</h2>
        <button className="primary" onClick={onCreate} disabled={creating}>
          {creating ? 'Creating…' : '+ New doc'}
        </button>
      </header>

      {status.kind === 'loading' && <p style={{ color: 'var(--muted)' }}>Loading…</p>}

      {status.kind === 'error' && (
        <div style={{ color: 'crimson' }}>
          <p>{status.message}</p>
          <button onClick={() => reload()}>Retry</button>
        </div>
      )}

      {status.kind === 'ready' && status.docs.length === 0 && (
        <p style={{ color: 'var(--muted)' }}>
          No docs yet. Click <strong>+ New doc</strong> to create the first one.
        </p>
      )}

      {status.kind === 'ready' && status.docs.length > 0 && (
        <table
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontSize: 14
          }}
        >
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--muted)' }}>
              <th style={cell()}>Title</th>
              <th style={cell()}>Created by</th>
              <th style={cell()}>Last edited by</th>
              <th style={cell({ textAlign: 'right' })}>Updated</th>
            </tr>
          </thead>
          <tbody>
            {status.docs.map((d) => (
              <tr
                key={d.id}
                onClick={() => nav(`/app/docs/${d.id}`)}
                style={{
                  cursor: 'pointer',
                  borderTop: '1px solid var(--border)'
                }}
              >
                <td style={cell()}>
                  <div>{d.title}</div>
                  <div style={{ color: 'var(--muted)', fontSize: 12 }}>
                    {d.slug} · {d.kind}
                  </div>
                </td>
                <td style={cell({ color: 'var(--muted)' })}>{personLabel(d.createdBy)}</td>
                <td style={cell({ color: 'var(--muted)' })}>
                  {/* updatedBy is null for never-edited docs; in that
                      case the creator is implicitly the last editor. */}
                  {personLabel(d.updatedBy ?? d.createdBy)}
                </td>
                <td style={cell({ textAlign: 'right', color: 'var(--muted)' })}>
                  {formatRelative(d.updatedAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function cell(extra: React.CSSProperties = {}): React.CSSProperties {
  return { padding: '8px 10px', ...extra }
}

export function personLabel(u: UserSummary | null | undefined): string {
  if (!u) return '—'
  // Prefer name; fall back to the local part of the email so the cell
  // stays short. The full email lives in the editor's info widget.
  if (u.name && u.name.length > 0) return u.name
  const at = u.email.indexOf('@')
  return at > 0 ? u.email.slice(0, at) : u.email
}

function explain(err: unknown): string {
  if (err instanceof ApiError && err.status === 401) return 'Your session expired. Refresh to sign in again.'
  if (err instanceof ApiError) return `Server returned HTTP ${err.status}.`
  if (err instanceof ApiSchemaError) return 'Server returned an unexpected response shape.'
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
