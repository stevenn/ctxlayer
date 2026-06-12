import { useCallback, useRef, useState } from 'react'

interface BusyOptions {
  /** Map a thrown value to user copy (screens pass their local `explain`). */
  explain: (err: unknown) => string
  /**
   * External error sink. When given, failures land there (and the reset
   * before each run clears it); the hook's own `error` stays null. Use this
   * when the screen shares one error state between loads and actions.
   */
  setError?: (msg: string | null) => void
  /** Runs at the start of every action, after the error reset (e.g. clear an info banner). */
  onStart?: () => void
  /** Runs after a failure is surfaced (e.g. reveal a confirm-hidden drawer). */
  onError?: () => void
}

/**
 * The repo's `withBusy` pattern as a hook: wrap an async action with a
 * busy flag, reset the error channel, and surface failures as
 * `"<label> failed: <explained>"`.
 *
 *   const { busy, error, run } = useBusyAction({ explain })
 *   const save = () => run(async () => { ... }, 'Save')
 */
export function useBusyAction(options: BusyOptions) {
  const [busy, setBusy] = useState(false)
  const [ownError, setOwnError] = useState<string | null>(null)
  // Latest options without forcing callers to memoise them.
  const optionsRef = useRef(options)
  optionsRef.current = options

  const run = useCallback(async (fn: () => Promise<void>, label: string): Promise<void> => {
    const opts = optionsRef.current
    const setError = opts.setError ?? setOwnError
    setBusy(true)
    setError(null)
    opts.onStart?.()
    try {
      await fn()
    } catch (err) {
      setError(`${label} failed: ${opts.explain(err)}`)
      opts.onError?.()
    } finally {
      setBusy(false)
    }
  }, [])

  return { busy, error: ownError, run }
}
