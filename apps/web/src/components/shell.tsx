import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { Button, Group, Stack, Text } from '@mantine/core'
import { ApiError, ApiSchemaError, fetchMe, fetchVersion, signOut } from '../lib/api'
import type { MeResponse, VersionResponse } from '@ctxlayer/shared'
import { ThemeToggle } from './theme-toggle'
import { BrandMark } from './brand-mark'

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
  {
    to: '/app/search',
    label: 'Search',
    matches: (p) => p === '/app' || p.startsWith('/app/search')
  },
  { to: '/app/docs', label: 'Context', matches: (p) => p.startsWith('/app/docs') },
  { to: '/app/upstreams', label: 'Upstreams' },
  { to: '/app/mcp-setup', label: 'MCP setup' },
  { to: '/app/usage', label: 'Usage' }
]

const ADMIN_NAV: NavSpec[] = [
  { to: '/app/admin/upstreams', label: 'Upstreams' },
  { to: '/app/admin/git-sources', label: 'Git repos' },
  { to: '/app/admin/skills', label: 'Skills', matches: (p) => p.startsWith('/app/admin/skills') },
  { to: '/app/admin/users', label: 'Users' },
  { to: '/app/admin/invites', label: 'Invites' },
  { to: '/app/admin/join-codes', label: 'Join codes' },
  { to: '/app/admin/teams', label: 'Teams' },
  { to: '/app/admin/roles', label: 'Roles' },
  { to: '/app/admin/products', label: 'Products' },
  { to: '/app/admin/usage', label: 'Usage' },
  { to: '/app/admin/audit', label: 'Audit' },
  { to: '/app/admin/oauth-clients', label: 'OAuth clients' }
]

const TITLES: Record<string, string> = {
  '/app/search': 'Search',
  '/app/docs': 'Context Library',
  '/app/upstreams': 'Upstreams',
  '/app/mcp-setup': 'MCP setup',
  '/app/usage': 'Usage',
  '/app/admin/upstreams': 'Admin · Upstreams',
  '/app/admin/git-sources': 'Admin · Git repos',
  '/app/admin/skills': 'Admin · Skills',
  '/app/admin/users': 'Admin · Users',
  '/app/admin/invites': 'Admin · Invites',
  '/app/admin/join-codes': 'Admin · Join codes',
  '/app/admin/teams': 'Admin · Teams',
  '/app/admin/roles': 'Admin · Roles',
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
        <Link to="/app/search" className="sidebar-brand">
          <BrandMark size={20} />
          <span>ctxlayer</span>
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
          <AppVersion />
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

// Build-provenance stamp shown under the user chip. Reads /api/version
// (injected at deploy time) so each environment/tenant advertises exactly
// which commit it runs — we never auto-upgrade, so this is the truth signal.
// Best-effort: a failed fetch or a local `bun run dev` (empty sha) shows
// `local` and never blocks the shell.
function AppVersion() {
  const [v, setV] = useState<VersionResponse | null>(null)
  useEffect(() => {
    const ctrl = new AbortController()
    fetchVersion(ctrl.signal).then(
      (res) => {
        if (!ctrl.signal.aborted) setV(res)
      },
      () => {
        /* version stamp is best-effort — ignore failures */
      }
    )
    return () => ctrl.abort()
  }, [])
  const sha = v?.gitSha?.trim()
  const date = v?.builtAt ? v.builtAt.slice(0, 10) : ''
  const label = sha ? (date ? `${sha} · ${date}` : sha) : 'local'
  return (
    <div className="app-version" title={v?.builtAt || 'local build'}>
      {label}
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
  // /app/docs/:id which should still show "Context Library".
  if (TITLES[pathname]) return TITLES[pathname]
  for (const [prefix, label] of Object.entries(TITLES)) {
    if (pathname.startsWith(prefix + '/')) return label
  }
  return 'ctxlayer'
}
