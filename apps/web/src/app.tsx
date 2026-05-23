import { Navigate, Route, Routes } from 'react-router-dom'
import { SignIn } from './routes/sign-in'
import { Docs } from './routes/docs'
import { Upstreams } from './routes/upstreams'
import { McpSetup } from './routes/mcp-setup'
import { Usage } from './routes/usage'
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
      </Route>
      <Route path="*" element={<Navigate to="/app/docs" replace />} />
    </Routes>
  )
}
