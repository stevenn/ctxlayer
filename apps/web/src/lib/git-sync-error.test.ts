import { describe, expect, it } from 'vitest'
import { gitSyncErrorMessage } from './git-sync-error'

describe('gitSyncErrorMessage', () => {
  it('names the real default branch on an enriched branch miss', () => {
    const msg = gitSyncErrorMessage('branch_not_found:main:master')
    expect(msg).toContain('“main”')
    expect(msg).toContain('“master”')
    expect(msg.toLowerCase()).toContain('default')
  })

  it('handles a branch miss with no known default', () => {
    const msg = gitSyncErrorMessage('branch_not_found:dev:')
    expect(msg).toContain('“dev”')
    expect(msg.toLowerCase()).toContain('case-sensitive')
  })

  it('explains a missing credential', () => {
    expect(gitSyncErrorMessage('no_read_token').toLowerCase()).toContain('credential')
  })

  it('maps the auth interstitial for any provider suffix', () => {
    for (const code of ['azure_auth_failed', 'github_auth_failed', 'gitlab_auth_failed']) {
      expect(gitSyncErrorMessage(code).toLowerCase()).toContain('authentication failed')
    }
  })

  it('maps api-error statuses to human messages', () => {
    expect(gitSyncErrorMessage('azure_api_error:404').toLowerCase()).toContain('not found')
    expect(gitSyncErrorMessage('github_api_error:403').toLowerCase()).toContain('access denied')
    expect(gitSyncErrorMessage('gitlab_api_error:401').toLowerCase()).toContain('unauthorized')
    expect(gitSyncErrorMessage('azure_api_error:500')).toContain('500')
  })

  it('falls through unknown codes verbatim', () => {
    expect(gitSyncErrorMessage('something_new')).toBe('something_new')
  })
})
