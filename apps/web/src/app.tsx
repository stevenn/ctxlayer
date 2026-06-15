import { Suspense, lazy, type ReactNode } from 'react'
import { Loader } from '@mantine/core'
import { Navigate, Route } from 'react-router-dom'
import { SignIn } from './routes/sign-in'
import { SearchHome } from './routes/search-home'
import { DocPathRedirect } from './routes/doc-path-redirect'
import { DocsList } from './routes/docs-list'
import { Upstreams } from './routes/upstreams'
import { McpSetup } from './routes/mcp-setup'
import { Usage } from './routes/usage'
import {
  AdminUpstreams,
  AdminGitSources,
  AdminUsers,
  AdminInvites,
  AdminJoinCodes,
  AdminTeams,
  AdminRoles,
  AdminProducts,
  AdminUsage,
  AdminAudit,
  AdminOAuthClients,
  AdminSkills
} from './routes/admin'
import { Shell } from './components/shell'
import { RouteError } from './components/route-error'

// The editor stack (BlockNote + ProseMirror + Yjs) is by far the heaviest
// dependency subtree in the app. Only two routes pull it in — lazy-load
// them so sign-in / search / admin don't ship megabytes of editor code.
// Chunk-load failures throw during render and land in the RouteError
// boundary like any other render error.
const DocsEditor = lazy(() =>
  import('./routes/docs-editor').then((m) => ({ default: m.DocsEditor }))
)
const AdminSkillEditor = lazy(() =>
  import('./routes/admin/skill-editor').then((m) => ({ default: m.AdminSkillEditor }))
)

function RouteLoading() {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: '20vh 0' }}>
      <Loader />
    </div>
  )
}

function Lazily({ children }: { children: ReactNode }) {
  return <Suspense fallback={<RouteLoading />}>{children}</Suspense>
}

/**
 * Returns the route tree as a fragment of `<Route>` elements. Consumed
 * by `createRoutesFromElements` in `main.tsx`, which feeds a data
 * router (createBrowserRouter). Data router is required so the editor
 * can use `useBlocker` for the unsaved-changes confirm dialog.
 *
 * Error boundaries live at two levels: the root one catches anything
 * (incl. failures in Shell itself); the pathless route under /app keeps
 * page-level render errors INSIDE the Shell's Outlet so navigation
 * survives. Both handle the ApiError(401) → /sign-in redirect.
 */
export function appRoutes() {
  return (
    <Route errorElement={<RouteError />}>
      <Route path="/sign-in" element={<SignIn />} />
      <Route path="/app" element={<Shell />}>
        <Route errorElement={<RouteError inShell />}>
          <Route index element={<Navigate to="/app/search" replace />} />
          <Route path="search" element={<SearchHome />} />
          <Route path="docs" element={<DocsList />} />
          <Route
            path="docs/:id"
            element={
              <Lazily>
                <DocsEditor />
              </Lazily>
            }
          />
          <Route path="upstreams" element={<Upstreams />} />
          <Route path="mcp-setup" element={<McpSetup />} />
          <Route path="usage" element={<Usage />} />
          <Route path="admin/upstreams" element={<AdminUpstreams />} />
          <Route path="admin/git-sources" element={<AdminGitSources />} />
          <Route path="admin/users" element={<AdminUsers />} />
          <Route path="admin/invites" element={<AdminInvites />} />
          <Route path="admin/join-codes" element={<AdminJoinCodes />} />
          <Route path="admin/teams" element={<AdminTeams />} />
          <Route path="admin/roles" element={<AdminRoles />} />
          <Route path="admin/products" element={<AdminProducts />} />
          <Route path="admin/usage" element={<AdminUsage />} />
          <Route path="admin/audit" element={<AdminAudit />} />
          <Route path="admin/oauth-clients" element={<AdminOAuthClients />} />
          <Route path="admin/skills" element={<AdminSkills />} />
          <Route
            path="admin/skills/:id/edit"
            element={
              <Lazily>
                <AdminSkillEditor />
              </Lazily>
            }
          />
        </Route>
      </Route>
      {/* OKF concept-path URLs (/dir/slug.md) resolve to the doc; anything
          else falls back to search. */}
      <Route path="*" element={<DocPathRedirect />} />
    </Route>
  )
}
