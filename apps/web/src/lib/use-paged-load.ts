import { useCallback, useEffect, useRef, useState } from 'react'
import { explain as explainBase } from './explain'

export type PagedStatus<T, C> =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; items: T[]; next: C | null; loadingMore: boolean }

interface PagedOptions {
  pageSize: number
  /** Map a thrown value to user copy (screens pass their local `explain`). */
  explain?: (err: unknown) => string
}

/**
 * The repo's cursor-paged load pattern as a hook — replaces the
 * hand-rolled Status unions in admin/audit.tsx and admin/oauth-clients.tsx.
 * The caller adapts its wire shape in `fetchPage` ({ items, next }); the
 * cursor type is the caller's own (numeric `before`, string cursor, …).
 *
 * Semantics (the safer superset of the two twins it replaces):
 *  - deps change → abort the in-flight load, back to 'loading', fetch fresh.
 *  - `loadMore()` registers its own AbortController so a concurrent
 *    reload drops the stale page instead of splicing it in, and is a
 *    no-op while already loading / at the end.
 *  - a loadMore failure surfaces as the error state (both twins did this).
 *  - `reload()` refetches page one, unsignalled, like `useLoad`'s reload.
 */
export function usePagedLoad<T, C>(
  fetchPage: (
    opts: { cursor: C | null; limit: number },
    signal?: AbortSignal
  ) => Promise<{ items: T[]; next: C | null }>,
  deps: unknown[],
  options: PagedOptions
): { status: PagedStatus<T, C>; loadMore: () => Promise<void>; reload: () => Promise<void> } {
  const [status, setStatus] = useState<PagedStatus<T, C>>({ kind: 'loading' })
  // Latest fetcher/options without forcing callers to memoise them.
  const fetchRef = useRef(fetchPage)
  fetchRef.current = fetchPage
  const optionsRef = useRef(options)
  optionsRef.current = options
  const ctrlRef = useRef<AbortController | null>(null)
  // Latest status for the stable loadMore callback (a setState updater
  // can't be used to READ state synchronously — updaters run later).
  const statusRef = useRef(status)
  statusRef.current = status

  const load = useCallback(async (signal?: AbortSignal) => {
    setStatus({ kind: 'loading' })
    try {
      const page = await fetchRef.current(
        { cursor: null, limit: optionsRef.current.pageSize },
        signal
      )
      if (signal?.aborted) return
      setStatus({ kind: 'ready', items: page.items, next: page.next, loadingMore: false })
    } catch (err) {
      if (signal?.aborted) return
      const msg = (optionsRef.current.explain ?? explainBase)(err)
      setStatus({ kind: 'error', message: msg })
    }
  }, [])

  useEffect(() => {
    const ctrl = new AbortController()
    // Kill any in-flight loadMore from the previous deps so its stale
    // page can't land after the fresh list arrives.
    ctrlRef.current?.abort()
    ctrlRef.current = ctrl
    void load(ctrl.signal)
    return () => ctrl.abort()
  }, deps)

  const loadMore = useCallback(async () => {
    const cur = statusRef.current
    if (cur.kind !== 'ready' || cur.next === null || cur.loadingMore) return
    const cursor = cur.next
    setStatus({ ...cur, loadingMore: true })
    // Registered as the current fetch so the next deps-change/reload
    // aborts it (the previous controller is already settled — we only
    // get here from a 'ready' state).
    const ctrl = new AbortController()
    ctrlRef.current = ctrl
    try {
      const page = await fetchRef.current({ cursor, limit: optionsRef.current.pageSize }, ctrl.signal)
      if (ctrl.signal.aborted) return
      setStatus((cur) =>
        cur.kind === 'ready'
          ? { kind: 'ready', items: [...cur.items, ...page.items], next: page.next, loadingMore: false }
          : cur
      )
    } catch (err) {
      if (ctrl.signal.aborted) return
      const msg = (optionsRef.current.explain ?? explainBase)(err)
      setStatus({ kind: 'error', message: msg })
    }
  }, [])

  const reload = useCallback(() => {
    ctrlRef.current?.abort()
    return load()
  }, [load])

  return { status, loadMore, reload }
}
