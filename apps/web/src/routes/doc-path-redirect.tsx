import { useEffect, useState } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { classifyHref } from '@ctxlayer/shared'
import { fetchDocs } from '../lib/api'

/**
 * Catch-all resolver: an OKF concept-path URL (e.g. `/specs/api/auth.md`) is a
 * real, navigable URL — resolve its slug to the doc and redirect to
 * `/app/docs/{id}`. This makes doc links work even when a full navigation
 * reaches the browser (a new tab BlockNote opens, a hard reload, a shared
 * link). Anything that isn't a doc path falls back to search.
 */
export function DocPathRedirect() {
  const { pathname } = useLocation()
  const [to, setTo] = useState<string | null>(null)

  useEffect(() => {
    const target = classifyHref(pathname)
    if (!target) {
      setTo('/app/search')
      return
    }
    if (target.kind === 'id') {
      setTo(`/app/docs/${target.id}`)
      return
    }
    let cancelled = false
    fetchDocs().then(
      (docs) => {
        if (cancelled) return
        const id = docs.find((d) => d.slug === target.slug)?.id
        setTo(id ? `/app/docs/${id}` : '/app/search')
      },
      () => {
        if (!cancelled) setTo('/app/search')
      }
    )
    return () => {
      cancelled = true
    }
  }, [pathname])

  if (!to) {
    return <div style={{ padding: 24, color: 'var(--text-dim)' }}>Resolving link…</div>
  }
  return <Navigate to={to} replace />
}
