import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { fetchMe } from '../lib/api'
import type { MeResponse } from '@ctxlayer/shared'

export function Shell() {
  const nav = useNavigate()
  const [me, setMe] = useState<MeResponse | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchMe().then(
      (m) => {
        setMe(m)
        setLoading(false)
      },
      () => {
        nav('/sign-in', { replace: true })
      }
    )
  }, [nav])

  if (loading) return <div style={{ padding: 32 }}>Loading…</div>
  if (!me) return null

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
