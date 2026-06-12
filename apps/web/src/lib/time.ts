/**
 * Shared time formatting for epoch-second timestamps.
 */

/**
 * Compact relative time: "42s ago" / "5m ago" / "3h ago" / "12d ago",
 * falling back to a locale date beyond ~30 days. Nullish (or zero)
 * timestamps render as `empty` (default em dash).
 */
export function relativeTime(ts: number | null | undefined, empty = '—'): string {
  if (!ts) return empty
  const now = Math.floor(Date.now() / 1000)
  const delta = now - ts
  if (delta < 60) return `${delta}s ago`
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`
  if (delta < 86400 * 30) return `${Math.floor(delta / 86400)}d ago`
  return new Date(ts * 1000).toLocaleDateString()
}

/** Full locale date + time, e.g. "6/12/2026, 10:04:00 AM". */
export function absDateTime(ts: number): string {
  return new Date(ts * 1000).toLocaleString()
}

/** Locale date only, e.g. "6/12/2026". */
export function absDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString()
}
