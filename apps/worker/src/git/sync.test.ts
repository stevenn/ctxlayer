import { describe, it, expect } from 'vitest'
import { isGitSyncDue, syncActionFor } from './sync'

const HOUR = 3600
const DAY = 24 * HOUR

describe('isGitSyncDue', () => {
  it('is always due when never synced', () => {
    expect(isGitSyncDue('hourly', null, 1_000_000)).toBe(true)
    expect(isGitSyncDue('weekly', null, 1_000_000)).toBe(true)
  })

  it('hourly: due after ~1h (with slack), not before', () => {
    const now = 1_000_000
    expect(isGitSyncDue('hourly', now - (HOUR - 200), now)).toBe(true) // within 5-min slack
    expect(isGitSyncDue('hourly', now - 600, now)).toBe(false) // synced 10 min ago
  })

  it('daily: due after ~24h', () => {
    const now = 2_000_000
    expect(isGitSyncDue('daily', now - DAY, now)).toBe(true)
    expect(isGitSyncDue('daily', now - 12 * HOUR, now)).toBe(false)
  })

  it('6x_daily and 2x_daily honor their gaps', () => {
    const now = 3_000_000
    expect(isGitSyncDue('6x_daily', now - 4 * HOUR, now)).toBe(true)
    expect(isGitSyncDue('6x_daily', now - 2 * HOUR, now)).toBe(false)
    expect(isGitSyncDue('2x_daily', now - 12 * HOUR, now)).toBe(true)
    expect(isGitSyncDue('2x_daily', now - 6 * HOUR, now)).toBe(false)
  })

  it('weekly: due after ~7d', () => {
    const now = 5_000_000
    expect(isGitSyncDue('weekly', now - 7 * DAY, now)).toBe(true)
    expect(isGitSyncDue('weekly', now - 3 * DAY, now)).toBe(false)
  })
})

describe('syncActionFor (clobber guard)', () => {
  const doc = (over: Partial<{ git_blob_sha: string | null; git_sync_state: string | null }>) => ({
    git_blob_sha: 'old-sha',
    git_sync_state: 'clean' as string | null,
    ...over
  })

  it('creates when the path has no doc yet', () => {
    expect(syncActionFor(null, 'sha')).toBe('create')
  })

  it('skips when the stored blob matches the tree entry', () => {
    expect(syncActionFor(doc({ git_blob_sha: 'sha' }), 'sha')).toBe('skip')
  })

  it('updates a clean doc whose blob moved', () => {
    expect(syncActionFor(doc({}), 'new-sha')).toBe('update')
    expect(syncActionFor(doc({ git_sync_state: null }), 'new-sha')).toBe('update')
  })

  it.each(['local_edits', 'pr_open', 'conflict'])(
    'never clobbers unmerged local work (%s)',
    (state) => {
      // 'conflict' is the regression case: it used to fall through to
      // 'update' on the pass AFTER the flag was set, silently overwriting
      // source.md underneath the stale collab snapshot.
      expect(syncActionFor(doc({ git_sync_state: state }), 'new-sha')).toBe('conflict')
    }
  )
})
