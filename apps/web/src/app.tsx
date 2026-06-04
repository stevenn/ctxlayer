import { Navigate, Route } from 'react-router-dom'
import { SignIn } from './routes/sign-in'
import { SearchHome } from './routes/search-home'
import { DocsList } from './routes/docs-list'
import { DocsEditor } from './routes/docs-editor'
import { Upstreams } from './routes/upstreams'
import { McpSetup } from './routes/mcp-setup'
import { Usage } from './routes/usage'
import {
  AdminUpstreams,
  AdminGitSources,
  AdminUsers,
  AdminTeams,
  AdminRoles,
  AdminProducts,
  AdminUsage,
  AdminAudit,
  AdminOAuthClients,
  AdminSkills,
  AdminSkillEditor
} from './routes/admin'
import { Shell } from './components/shell'
import { RouteError } from './components/route-error'

/**
 * Returns the route tree as a fragment of `<Route>` elements. Consumed
 * by `createRoutesFromElements` in `main.tsx`, which feeds a data
 * router (createBrowserRouter). Data router is required so the editor
 * can use `useBlocker` for the unsaved-changes confirm dialog.
 */
export function appRoutes() {
  return (
    <Route errorElement={<RouteError />}>
      <Route path="/sign-in" element={<SignIn />} />
      <Route path="/app" element={<Shell />}>
        <Route index element={<Navigate to="/app/search" replace />} />
        <Route path="search" element={<SearchHome />} />
        <Route path="docs" element={<DocsList />} />
        <Route path="docs/:id" element={<DocsEditor />} />
        <Route path="upstreams" element={<Upstreams />} />
        <Route path="mcp-setup" element={<McpSetup />} />
        <Route path="usage" element={<Usage />} />
        <Route path="admin/upstreams" element={<AdminUpstreams />} />
        <Route path="admin/git-sources" element={<AdminGitSources />} />
        <Route path="admin/users" element={<AdminUsers />} />
        <Route path="admin/teams" element={<AdminTeams />} />
        <Route path="admin/roles" element={<AdminRoles />} />
        <Route path="admin/products" element={<AdminProducts />} />
        <Route path="admin/usage" element={<AdminUsage />} />
        <Route path="admin/audit" element={<AdminAudit />} />
        <Route path="admin/oauth-clients" element={<AdminOAuthClients />} />
        <Route path="admin/skills" element={<AdminSkills />} />
        <Route path="admin/skills/:id/edit" element={<AdminSkillEditor />} />
      </Route>
      <Route path="*" element={<Navigate to="/app/search" replace />} />
    </Route>
  )
}
