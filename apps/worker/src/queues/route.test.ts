import { describe, expect, it } from 'vitest'
import { queueKind } from './route'

describe('queueKind', () => {
  it('routes the canonical (unprefixed) queue names', () => {
    expect(queueKind('ctxlayer-usage')).toBe('usage')
    expect(queueKind('ctxlayer-reindex')).toBe('reindex')
    expect(queueKind('ctxlayer-git-sync')).toBe('git-sync')
    expect(queueKind('ctxlayer-jobs')).toBe('jobs')
  })

  it('routes tenant-prefixed queue names (the bug this fixes)', () => {
    expect(queueKind('ctxlayer-yukitools-usage')).toBe('usage')
    expect(queueKind('ctxlayer-yukitools-reindex')).toBe('reindex')
    expect(queueKind('ctxlayer-yukitools-git-sync')).toBe('git-sync')
    expect(queueKind('ctxlayer-yukitools-jobs')).toBe('jobs')
    expect(queueKind('ctxlayer-dev-usage')).toBe('usage')
  })

  it('does not misroute: git-sync is distinct from usage/reindex', () => {
    // ends with -git-sync, not -usage/-reindex
    expect(queueKind('ctxlayer-anything-git-sync')).toBe('git-sync')
  })

  it('returns null for an unknown queue', () => {
    expect(queueKind('ctxlayer-yukitools-other')).toBeNull()
    expect(queueKind('something-else')).toBeNull()
    expect(queueKind('')).toBeNull()
  })
})
