/**
 * Autosave coalescing policy — pure decision function shared by the doc
 * and skill save handlers. Kept free of D1/R2 so the matrix is unit
 * testable without the workers harness (see revision-policy.test.ts).
 *
 * The handlers autosave on a 3s idle debounce. Persisting each one as its
 * own revision turns the history into per-keystroke noise. Instead an
 * autosave folds into a single rolling revision per editing burst; only
 * an explicit Save (or a different author, or the window expiring) cuts a
 * distinct checkpoint. Identical content is a no-op. The head autosave
 * always holds the latest bytes, so crash-insurance is unchanged — only
 * the *granularity* of restorable points is coarsened.
 */

export type RevisionKind = 'autosave' | 'explicit'

/**
 * Max age of a rolling autosave revision, measured from its birth. While
 * editing continuously, autosaves keep amending the same row until it
 * crosses this window, then a fresh one is cut — bounding history growth
 * to at most one autosave row per author per window per doc. Five minutes
 * loses nothing for crash-insurance (the head row always has the latest
 * content); it only sets how far back a restore can step.
 */
export const AUTOSAVE_COALESCE_WINDOW_SECONDS = 5 * 60

/** The current head revision of a doc/skill (its `current_rev_id` row). */
export interface HeadRevision {
  id: string
  authorId: string | null
  contentHash: string
  createdAt: number
  kind: RevisionKind
}

export interface RevisionDecisionInput {
  contentHash: string
  userId: string
  /** True for a user Save click; false for a background autosave. */
  explicit: boolean
  /** Unix seconds — injected so the function stays pure/testable. */
  now: number
}

export type RevisionDecision =
  // Content identical to the head: nothing to write.
  | { action: 'noop'; revisionId: string }
  // Content identical, but an explicit save promotes the head autosave to
  // an explicit checkpoint so the next autosave won't overwrite it.
  | { action: 'seal'; revisionId: string }
  // Overwrite the rolling autosave head in place.
  | { action: 'amend'; revisionId: string }
  // Cut a brand-new revision of the given kind.
  | { action: 'new'; kind: RevisionKind }

/**
 * Decide what a save should do given the current head. Order matters:
 * dedup first (cheapest + covers undo-to-identical), then coalesce, then
 * fall through to a fresh revision.
 */
export function decideRevision(
  head: HeadRevision | null,
  input: RevisionDecisionInput
): RevisionDecision {
  if (head && head.contentHash === input.contentHash) {
    if (input.explicit && head.kind === 'autosave') {
      return { action: 'seal', revisionId: head.id }
    }
    return { action: 'noop', revisionId: head.id }
  }

  const coalesceable =
    !input.explicit &&
    head !== null &&
    head.kind === 'autosave' &&
    head.authorId === input.userId &&
    input.now - head.createdAt < AUTOSAVE_COALESCE_WINDOW_SECONDS

  if (coalesceable) {
    return { action: 'amend', revisionId: head!.id }
  }

  return { action: 'new', kind: input.explicit ? 'explicit' : 'autosave' }
}
