import { Navigate, Route, Routes } from 'react-router-dom'
import { SignIn } from './routes/sign-in'
import { Docs } from './routes/docs'
import { Upstreams } from './routes/upstreams'
import { McpSetup } from './routes/mcp-setup'
import { Usage } from './routes/usage'
import {
  AdminUpstreams,
  AdminUsers,
  AdminTeams,
  AdminProducts,
  AdminUsage,
  AdminAudit
} from './routes/admin'
import { Shell } from './components/shell'

export function App() {
  return (
    <Routes>
      <Route path="/sign-in" element={<SignIn />} />
      <Route path="/app" element={<Shell />}>
        <Route index element={<Navigate to="/app/docs" replace />} />
        <Route path="docs/*" element={<Docs />} />
        <Route path="upstreams" element={<Upstreams />} />
        <Route path="mcp-setup" element={<McpSetup />} />
        <Route path="usage" element={<Usage />} />
        <Route path="admin/upstreams" element={<AdminUpstreams />} />
        <Route path="admin/users" element={<AdminUsers />} />
        <Route path="admin/teams" element={<AdminTeams />} />
        <Route path="admin/products" element={<AdminProducts />} />
        <Route path="admin/usage" element={<AdminUsage />} />
        <Route path="admin/audit" element={<AdminAudit />} />
      </Route>
      <Route path="*" element={<Navigate to="/app/docs" replace />} />
    </Routes>
  )
}
