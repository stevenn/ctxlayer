import { Button, Code, Stack, Text } from '@mantine/core'
import { Navigate, useRouteError } from 'react-router-dom'
import { ApiError } from '../lib/api'

/**
 * Router `errorElement` — the SPA's last line of defence. A render-time
 * throw anywhere in the tree (e.g. an `ApiSchemaError` surfaced during
 * render, or any component bug) lands here instead of white-screening the
 * page. A 401 that reaches this far bounces to sign-in; everything else
 * shows a recoverable error with a reload affordance.
 *
 * `inShell` is set on the pathless boundary nested under /app: the error
 * UI then renders inside the Shell's Outlet (nav stays usable) instead
 * of as a full-page auth-shell takeover.
 */
export function RouteError({ inShell = false }: { inShell?: boolean }) {
  const error = useRouteError()

  if (error instanceof ApiError && error.status === 401) {
    return <Navigate to="/sign-in" replace />
  }

  const detail =
    error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown error'

  const body = (
    <Stack gap="md" maw={480}>
      <Text fw={600} fz="lg">
        Something went wrong
      </Text>
      <Text c="dimmed">
        This page hit an unexpected error and couldn't render. Reloading usually clears it; if it
        keeps happening, please report it.
      </Text>
      <Code block>{detail}</Code>
      <Button onClick={() => window.location.reload()}>Reload</Button>
    </Stack>
  )

  if (inShell) return body
  return <div className="auth-shell">{body}</div>
}
