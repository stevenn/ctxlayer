import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { ApiError, ApiSchemaError, fetchMe } from '../lib/api'
import type { MeResponse } from '@ctxlayer/shared'

type Status =
  | { kind: 'loading' }
  | { kind: 'ready'; me: MeResponse }
  | { kind: 'error'; message: string }

export function Shell() {
  const nav = useNavigate()
  const [status, setStatus] = useState<Status>({ kind: 'loading' })

  useEffect(() => {
    const ctrl = new AbortController()
    fetchMe(ctrl.signal).then(
      (me) => {
        if (!ctrl.signal.aborted) setStatus({ kind: 'ready', me })
      },
      (err) => {
        if (ctrl.signal.aborted) return
        if (err instanceof ApiError && err.status === 401) {
          nav('/sign-in', { replace: true })
          return
        }
        // Schema mismatch / network / 5xx: surface the error rather than
        // bouncing to /sign-in, which would loop indefinitely.
        const message =
          err instanceof ApiSchemaError
            ? 'The server returned an unexpected response shape.'
            : err instanceof ApiError
              ? `Sign-in check failed (HTTP ${err.status}).`
              : 'Could not reach the server.'
        setStatus({ kind: 'error', message })
      }
    )
    return () => ctrl.abort()
  }, [nav])

  if (status.kind === 'loading') return <div style={{ padding: 32 }}>Loading…</div>
  if (status.kind === 'error') {
    return (
      <div style={{ padding: 32, maxWidth: 480 }}>
        <h2 style={{ marginTop: 0 }}>Something went wrong</h2>
        <p style={{ color: 'var(--muted)' }}>{status.message}</p>
        <button onClick={() => location.reload()}>Retry</button>
      </div>
    )
  }
  const { me } = status

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', minHeight: '100%' }}>
      <aside
        style={{
          borderRight: '1px solid var(--border)',
          padding: '20px 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: 8
        }}
      >
        <Link to="/app/docs" style={{ fontWeight: 700, fontSize: 18, marginBottom: 12 }}>
          ctxlayer
        </Link>
        <NavItem to="/app/docs">Docs</NavItem>
        <NavItem to="/app/upstreams">Upstreams</NavItem>
        <NavItem to="/app/mcp-setup">MCP setup</NavItem>
        <NavItem to="/app/usage">Usage</NavItem>
        {me.role === 'admin' ? (
          <>
            <div style={{ marginTop: 16, fontSize: 12, color: 'var(--muted)' }}>Admin</div>
            <NavItem to="/app/admin/upstreams">Upstreams</NavItem>
            <NavItem to="/app/admin/users">Users</NavItem>
            <NavItem to="/app/admin/teams">Teams</NavItem>
            <NavItem to="/app/admin/products">Products</NavItem>
            <NavItem to="/app/admin/usage">Usage</NavItem>
            <NavItem to="/app/admin/audit">Audit</NavItem>
          </>
        ) : null}
        <div style={{ marginTop: 'auto', fontSize: 12, color: 'var(--muted)' }}>
          Signed in as {me.email}
        </div>
      </aside>
      <main style={{ padding: 24 }}>
        <Outlet />
      </main>
    </div>
  )
}

function NavItem({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <NavLink
      to={to}
      style={({ isActive }) => ({
        padding: '6px 8px',
        borderRadius: 4,
        background: isActive ? 'var(--border)' : 'transparent',
        color: 'var(--fg)'
      })}
    >
      {children}
    </NavLink>
  )
}
