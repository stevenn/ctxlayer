import { useCallback, useEffect, useRef, useState } from 'react'
import { explain as explainBase } from './explain'

interface LoadOptions {
  /** Map a thrown value to user copy (screens pass their local `explain`). */
  explain?: (err: unknown) => string
  /**
   * External error sink. When given, load failures are routed there and the
   * hook's own `error` stays null — use it when the screen shares one error
   * state between the load and its mutations. Pass a no-op to swallow
   * best-effort load failures.
   */
  onError?: (msg: string) => void
}

/**
 * The repo's load pattern as a hook: fetch on mount (and whenever `deps`
 * change) with an AbortController so a stale response never lands, plus a
 * `reload()` for after-mutation refreshes (called without a signal, exactly
 * like the hand-rolled `reload()`s it replaces).
 *
 * Matches the established semantics: `data` keeps its previous value while a
 * reload is in flight, and a successful load does NOT clear a previous error.
 */
export function useLoad<T>(
  fetcher: (signal?: AbortSignal) => Promise<T>,
  deps: unknown[],
  options: LoadOptions = {}
): { data: T | null; error: string | null; reload: () => Promise<void> } {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Latest fetcher/options without forcing callers to memoise them.
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher
  const optionsRef = useRef(options)
  optionsRef.current = options

  const run = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await fetcherRef.current(signal)
      if (!signal?.aborted) setData(result)
    } catch (err) {
      if (signal?.aborted) return
      const opts = optionsRef.current
      const msg = (opts.explain ?? explainBase)(err)
      if (opts.onError) opts.onError(msg)
      else setError(msg)
    }
  }, [])

  useEffect(() => {
    const ctrl = new AbortController()
    void run(ctrl.signal)
    return () => ctrl.abort()
  }, deps)

  const reload = useCallback(() => run(), [run])

  return { data, error, reload }
}
