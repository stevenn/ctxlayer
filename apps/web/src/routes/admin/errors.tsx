import { ErrorsPage } from '../../components/usage/errors-page'
import { fetchAdminUsageErrors } from '../../lib/api'

/** Admin · Errors — org-wide failed tool calls with user attribution. */
export function AdminErrors() {
  return (
    <ErrorsPage
      title="Admin · Errors"
      subtitle="Individual failed tool calls — credential-scrubbed root detail (host/IP/URL kept)."
      scope="admin"
      showUser
      fetchErrors={fetchAdminUsageErrors}
    />
  )
}
