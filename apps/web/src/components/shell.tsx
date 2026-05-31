import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { Button, Group, Stack, Text } from '@mantine/core'
import { ApiError, ApiSchemaError, fetchMe, signOut } from '../lib/api'
import type { MeResponse } from '@ctxlayer/shared'
import { ThemeToggle } from './theme-toggle'

type Status =
  | { kind: 'loading' }
  | { kind: 'ready'; me: MeResponse }
  | { kind: 'error'; message: string }

interface NavSpec {
  to: string
  label: string
  // True only when the current path is THIS link (so nested routes
  // like /app/docs/:id still light the Docs nav).
  matches?: (pathname: string) => boolean
}

const PRIMARY_NAV: NavSpec[] = [
  { to: '/app/docs', label: 'Docs', matches: (p) => p.startsWith('/app/docs') },
  { to: '/app/upstreams', label: 'Upstreams' },
  { to: '/app/mcp-setup', label: 'MCP setup' },
  { to: '/app/usage', label: 'Usage' }
]

const ADMIN_NAV: NavSpec[] = [
  { to: '/app/admin/upstreams', label: 'Upstreams' },
  { to: '/app/admin/git-sources', label: 'Git repos' },
  { to: '/app/admin/skills', label: 'Skills', matches: (p) => p.startsWith('/app/admin/skills') },
  { to: '/app/admin/users', label: 'Users' },
  { to: '/app/admin/teams', label: 'Teams' },
  { to: '/app/admin/products', label: 'Products' },
  { to: '/app/admin/usage', label: 'Usage' },
  { to: '/app/admin/audit', label: 'Audit' },
  { to: '/app/admin/oauth-clients', label: 'OAuth clients' }
]

const TITLES: Record<string, string> = {
  '/app/docs': 'Docs library',
  '/app/upstreams': 'Upstreams',
  '/app/mcp-setup': 'MCP setup',
  '/app/usage': 'Usage',
  '/app/admin/upstreams': 'Admin · Upstreams',
  '/app/admin/git-sources': 'Admin · Git repos',
  '/app/admin/skills': 'Admin · Skills',
  '/app/admin/users': 'Admin · Users',
  '/app/admin/teams': 'Admin · Teams',
  '/app/admin/products': 'Admin · Products',
  '/app/admin/usage': 'Admin · Usage',
  '/app/admin/audit': 'Admin · Audit',
  '/app/admin/oauth-clients': 'Admin · OAuth clients'
}

export function Shell() {
  const nav = useNavigate()
  const location = useLocation()
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

  if (status.kind === 'loading') {
    return (
      <div className="auth-shell">
        <Text c="dimmed">Loading…</Text>
      </div>
    )
  }
  if (status.kind === 'error') {
    return (
      <div className="auth-shell">
        <Stack gap="md" maw={420}>
          <Text fw={600} fz="lg">
            Something went wrong
          </Text>
          <Text c="dimmed">{status.message}</Text>
          <Button onClick={() => window.location.reload()}>Retry</Button>
        </Stack>
      </div>
    )
  }

  const { me } = status
  const title = matchTitle(location.pathname)

  async function onSignOut() {
    try {
      await signOut()
    } catch (err) {
      // Even if the server call fails (e.g. CSRF cookie missing), the
      // user clearly wants out — bounce them to /sign-in.
      console.warn('signout call failed', err)
    } finally {
      nav('/sign-in', { replace: true })
    }
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <Link to="/app/docs" className="sidebar-brand">
          ctxlayer
        </Link>

        {PRIMARY_NAV.map((item) => (
          <NavItem key={item.to} item={item} pathname={location.pathname} />
        ))}

        {me.role === 'admin' && (
          <>
            <div className="sidebar-group-label">Admin</div>
            {ADMIN_NAV.map((item) => (
              <NavItem key={item.to} item={item} pathname={location.pathname} />
            ))}
          </>
        )}

        <div className="sidebar-footer">
          <div className="user-chip">
            <span className="user-chip-email">{me.email}</span>
            <span className="user-chip-role">{me.role}</span>
          </div>
        </div>
      </aside>

      <div className="main-area">
        <header className="main-header">
          <span className="main-title">{title}</span>
          <Group gap="xs">
            <ThemeToggle />
            <Button variant="default" size="xs" onClick={onSignOut}>
              Sign out
            </Button>
          </Group>
        </header>
        <main className="main-content">
          <Outlet />
        </main>
      </div>
    </div>
  )
}

function NavItem({ item, pathname }: { item: NavSpec; pathname: string }) {
  const active = item.matches ? item.matches(pathname) : pathname === item.to
  return (
    <NavLink to={item.to} className={`nav-item${active ? ' active' : ''}`}>
      {item.label}
    </NavLink>
  )
}

function matchTitle(pathname: string): string {
  // Direct match first, then prefix match for nested routes like
  // /app/docs/:id which should still show "Docs library".
  if (TITLES[pathname]) return TITLES[pathname]
  for (const [prefix, label] of Object.entries(TITLES)) {
    if (pathname.startsWith(prefix + '/')) return label
  }
  return 'ctxlayer'
}
