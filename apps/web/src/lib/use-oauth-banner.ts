import { useEffect, useState } from 'react'

export type OAuthFlash = { kind: 'ok' | 'err'; message: string }

/**
 * Surfaces the flash params the upstream-OAuth callback bounces back on the
 * URL — `?oauth_connected=<slug>` or `?oauth_error=<code>&desc=<…>` — as a
 * dismissable banner, then scrubs them via replaceState so a reload doesn't
 * re-show the banner.
 */
export function useOAuthFlashBanner(): { banner: OAuthFlash | null; clear: () => void } {
  const [banner, setBanner] = useState<OAuthFlash | null>(null)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const connected = params.get('oauth_connected')
    const errCode = params.get('oauth_error')
    if (connected) {
      setBanner({ kind: 'ok', message: `Connected ${connected}.` })
    } else if (errCode) {
      const desc = params.get('desc') ?? ''
      setBanner({
        kind: 'err',
        message: `OAuth failed: ${errCode}${desc ? ` — ${desc}` : ''}`
      })
    }
    if (connected || errCode) {
      params.delete('oauth_connected')
      params.delete('oauth_error')
      params.delete('desc')
      const qs = params.toString()
      window.history.replaceState({}, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`)
    }
  }, [])

  return { banner, clear: () => setBanner(null) }
}
