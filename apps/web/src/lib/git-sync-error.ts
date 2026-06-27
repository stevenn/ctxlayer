/**
 * Map a git source's raw `lastSyncError` code into a human-friendly message.
 *
 * Codes are provider-prefixed (`azure_` / `github_` / `gitlab_`); we match on
 * the stable SUFFIXES so all three providers share one mapping. Unknown codes
 * fall through verbatim (still better than hiding them).
 */
export function gitSyncErrorMessage(code: string): string {
  const c = (code ?? '').trim()
  if (!c) return ''

  // Enriched branch miss: `branch_not_found:<typed>:<default>` (default may be '').
  if (c.startsWith('branch_not_found:')) {
    const parts = c.split(':')
    const typed = parts[1] ?? ''
    const def = parts[2] ?? ''
    const base = `Branch “${typed}” not found in the repo.`
    return def
      ? `${base} The repo’s default branch is “${def}” — update the Branch field (branches are case-sensitive).`
      : `${base} Check the name — branches are case-sensitive.`
  }

  if (c === 'no_read_token')
    return 'No credential connected. Add a read token, or configure OAuth and click Connect.'
  if (c === 'repo_no_default_branch')
    return 'The repo has no commits yet — there is no default branch to sync.'
  if (c === 'source_disabled') return 'This source is disabled — enable it to sync.'
  if (c === 'source_not_found') return 'This source no longer exists.'

  // Auth interstitial (wrong token scope/audience or expired) — any provider.
  if (/_auth_failed$/.test(c))
    return 'Authentication failed — the token was rejected (wrong scope/audience or expired). Re-enter the token, or Disconnect → Connect to re-authorize.'

  // Legacy/raw ref-unresolved (pre branch_not_found enrichment).
  if (/_ref_unresolved$/.test(c))
    return 'Branch not found — check the Branch field (case-sensitive; ADO repos often default to “master”).'

  // `<provider>_api_error:<status>`
  const apiErr = c.match(/_api_error:(\d{3})$/)
  if (apiErr) {
    const status = apiErr[1]!
    if (status === '401') return 'Unauthorized — the token is invalid or expired.'
    if (status === '403') return 'Access denied — the token lacks permission on this repo.'
    if (status === '404') return 'Not found — check that owner / project / repo are correct.'
    if (status.startsWith('5'))
      return `The git provider returned a server error (${status}). Try again shortly.`
    return `The git provider rejected the request (HTTP ${status}).`
  }

  if (/_not_a_file$/.test(c)) return 'A configured path resolved to something that isn’t a file.'

  // Unknown — surface verbatim so nothing is silently hidden.
  return c
}
