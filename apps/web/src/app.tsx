import { Navigate, Route } from 'react-router-dom'
import { SignIn } from './routes/sign-in'
import { DocsList } from './routes/docs-list'
import { DocsEditor } from './routes/docs-editor'
import { Upstreams } from './routes/upstreams'
import { McpSetup } from './routes/mcp-setup'
import { Usage } from './routes/usage'
import {
  AdminUpstreams,
  AdminUsers,
  AdminTeams,
  AdminProducts,
  AdminUsage,
  AdminAudit,
  AdminOAuthClients
} from './routes/admin'
import { Shell } from './components/shell'

/**
 * Returns the route tree as a fragment of `<Route>` elements. Consumed
 * by `createRoutesFromElements` in `main.tsx`, which feeds a data
 * router (createBrowserRouter). Data router is required so the editor
 * can use `useBlocker` for the unsaved-changes confirm dialog.
 */
export function appRoutes() {
  return (
    <>
      <Route path="/sign-in" element={<SignIn />} />
      <Route path="/app" element={<Shell />}>
        <Route index element={<Navigate to="/app/docs" replace />} />
        <Route path="docs" element={<DocsList />} />
        <Route path="docs/:id" element={<DocsEditor />} />
        <Route path="upstreams" element={<Upstreams />} />
        <Route path="mcp-setup" element={<McpSetup />} />
        <Route path="usage" element={<Usage />} />
        <Route path="admin/upstreams" element={<AdminUpstreams />} />
        <Route path="admin/users" element={<AdminUsers />} />
        <Route path="admin/teams" element={<AdminTeams />} />
        <Route path="admin/products" element={<AdminProducts />} />
        <Route path="admin/usage" element={<AdminUsage />} />
        <Route path="admin/audit" element={<AdminAudit />} />
        <Route path="admin/oauth-clients" element={<AdminOAuthClients />} />
      </Route>
      <Route path="*" element={<Navigate to="/app/docs" replace />} />
    </>
  )
}
