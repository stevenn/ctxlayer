import { ErrorsPage } from '../components/usage/errors-page'
import { fetchUsageErrors } from '../lib/api'

/** Personal errors feed — self-scoped, like the Usage dashboard. */
export function Errors() {
  return (
    <ErrorsPage
      title="Your errors"
      subtitle="Individual failed tool calls — credential-scrubbed root detail."
      scope="personal"
      fetchErrors={fetchUsageErrors}
    />
  )
}
