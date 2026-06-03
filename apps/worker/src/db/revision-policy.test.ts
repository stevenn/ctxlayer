import { describe, expect, it } from 'vitest'
import {
  AUTOSAVE_COALESCE_WINDOW_SECONDS,
  decideRevision,
  type HeadRevision
} from './revision-policy'

const T0 = 1_780_000_000

function head(over: Partial<HeadRevision> = {}): HeadRevision {
  return {
    id: 'rev-head',
    authorId: 'alice',
    contentHash: 'hash-A',
    createdAt: T0,
    kind: 'autosave',
    ...over
  }
}

describe('decideRevision', () => {
  it('no head yet → new revision (autosave or explicit per the flag)', () => {
    expect(decideRevision(null, { contentHash: 'h', userId: 'alice', explicit: false, now: T0 })).toEqual({
      action: 'new',
      kind: 'autosave'
    })
    expect(decideRevision(null, { contentHash: 'h', userId: 'alice', explicit: true, now: T0 })).toEqual({
      action: 'new',
      kind: 'explicit'
    })
  })

  it('autosave folds into an in-window same-author autosave head (amend, not insert)', () => {
    const d = decideRevision(head(), {
      contentHash: 'hash-B',
      userId: 'alice',
      explicit: false,
      now: T0 + 30
    })
    expect(d).toEqual({ action: 'amend', revisionId: 'rev-head' })
  })

  it('autosave just inside the window still amends; one second past it cuts a new row', () => {
    const justInside = decideRevision(head(), {
      contentHash: 'hash-B',
      userId: 'alice',
      explicit: false,
      now: T0 + AUTOSAVE_COALESCE_WINDOW_SECONDS - 1
    })
    expect(justInside.action).toBe('amend')

    const past = decideRevision(head(), {
      contentHash: 'hash-B',
      userId: 'alice',
      explicit: false,
      now: T0 + AUTOSAVE_COALESCE_WINDOW_SECONDS
    })
    expect(past).toEqual({ action: 'new', kind: 'autosave' })
  })

  it('a different author never coalesces — cuts a fresh autosave row', () => {
    const d = decideRevision(head({ authorId: 'alice' }), {
      contentHash: 'hash-B',
      userId: 'bob',
      explicit: false,
      now: T0 + 5
    })
    expect(d).toEqual({ action: 'new', kind: 'autosave' })
  })

  it('an explicit save never amends — always a distinct checkpoint', () => {
    const d = decideRevision(head(), {
      contentHash: 'hash-B',
      userId: 'alice',
      explicit: true,
      now: T0 + 5
    })
    expect(d).toEqual({ action: 'new', kind: 'explicit' })
  })

  it('an autosave does NOT fold into an explicit head — explicit checkpoints are frozen', () => {
    const d = decideRevision(head({ kind: 'explicit' }), {
      contentHash: 'hash-B',
      userId: 'alice',
      explicit: false,
      now: T0 + 5
    })
    expect(d).toEqual({ action: 'new', kind: 'autosave' })
  })

  it('identical content is a no-op (dedup) for an autosave', () => {
    const d = decideRevision(head({ contentHash: 'hash-A' }), {
      contentHash: 'hash-A',
      userId: 'alice',
      explicit: false,
      now: T0 + 5
    })
    expect(d).toEqual({ action: 'noop', revisionId: 'rev-head' })
  })

  it('identical content + explicit save promotes a head autosave to explicit (seal)', () => {
    const d = decideRevision(head({ kind: 'autosave', contentHash: 'hash-A' }), {
      contentHash: 'hash-A',
      userId: 'alice',
      explicit: true,
      now: T0 + 5
    })
    expect(d).toEqual({ action: 'seal', revisionId: 'rev-head' })
  })

  it('identical content + explicit save on an already-explicit head is a plain no-op', () => {
    const d = decideRevision(head({ kind: 'explicit', contentHash: 'hash-A' }), {
      contentHash: 'hash-A',
      userId: 'alice',
      explicit: true,
      now: T0 + 5
    })
    expect(d).toEqual({ action: 'noop', revisionId: 'rev-head' })
  })

  it('a continuous autosave burst persists ONE row, not one per save', () => {
    // Simulate the editor: a fresh doc, then autosaves every 30s. Replays
    // the policy against a tiny in-memory head to count real inserts.
    let inserts = 0
    let amends = 0
    let current: HeadRevision | null = null

    for (let i = 0; i < 20; i++) {
      const now = T0 + i * 30 // 20 saves over 10 minutes
      const d = decideRevision(current, {
        contentHash: `hash-${i}`, // every save changes content
        userId: 'alice',
        explicit: false,
        now
      })
      if (d.action === 'new') {
        inserts++
        current = { id: `rev-${i}`, authorId: 'alice', contentHash: `hash-${i}`, createdAt: now, kind: 'autosave' }
      } else if (d.action === 'amend') {
        amends++
        // amend keeps the row + its createdAt anchor, refreshes content
        current = { ...current!, contentHash: `hash-${i}` }
      }
    }

    // 10 minutes of continuous typing with a 5-minute window → 2 rows total
    // (the first window + the rollover), not 20.
    expect(inserts).toBe(2)
    expect(amends).toBe(18)
  })
})
