import type { UsageDailyTotal } from '@ctxlayer/shared'

/**
 * Inline SVG charts used by the M6 usage pages. Hand-rolled to avoid
 * pulling in recharts / mantine-charts and the ~100KB they'd add.
 * Two views:
 *
 *   - `DailyBars` — one bar per day for the last N days; stacked
 *     request- and response-tokens.
 *   - `Sparkline` — line over the daily call count for compact
 *     embedding inside leaderboard rows or summary headers.
 */

const SECONDS_PER_DAY = 86400

interface Sized {
  width?: number
  height?: number
}

export function DailyBars({
  rows,
  daysBack,
  width = 720,
  height = 180
}: { rows: UsageDailyTotal[]; daysBack: number } & Sized) {
  const days = fillDays(rows, daysBack)
  const maxTokens = Math.max(1, ...days.map((d) => d.reqTokens + d.respTokens))
  const barWidth = width / days.length
  const padX = 1

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      style={{ display: 'block', maxWidth: '100%' }}
      role="img"
      aria-label="Daily request + response tokens"
    >
      {days.map((d, i) => {
        const totalH = ((d.reqTokens + d.respTokens) / maxTokens) * (height - 20)
        const reqH = (d.reqTokens / maxTokens) * (height - 20)
        const x = i * barWidth
        const yTop = height - totalH
        return (
          <g key={d.day}>
            <title>
              {fmtDate(d.day)} — {d.calls} call{d.calls === 1 ? '' : 's'}, req{' '}
              {d.reqTokens} tok, resp {d.respTokens} tok
              {d.errors > 0 ? `, ${d.errors} error${d.errors === 1 ? '' : 's'}` : ''}
            </title>
            {/* resp tokens (top half) */}
            <rect
              x={x + padX}
              y={yTop}
              width={Math.max(0, barWidth - 2 * padX)}
              height={Math.max(0, totalH - reqH)}
              fill="var(--mantine-color-blue-4)"
            />
            {/* req tokens (bottom half) */}
            <rect
              x={x + padX}
              y={height - reqH}
              width={Math.max(0, barWidth - 2 * padX)}
              height={Math.max(0, reqH)}
              fill="var(--mantine-color-violet-5)"
            />
            {d.errors > 0 && (
              <circle
                cx={x + barWidth / 2}
                cy={4}
                r={2}
                fill="var(--mantine-color-red-6)"
              />
            )}
          </g>
        )
      })}
    </svg>
  )
}

export function Sparkline({
  rows,
  daysBack,
  width = 140,
  height = 28
}: { rows: UsageDailyTotal[]; daysBack: number } & Sized) {
  const days = fillDays(rows, daysBack)
  const max = Math.max(1, ...days.map((d) => d.calls))
  if (days.length < 2) return <span style={{ fontSize: 11, opacity: 0.5 }}>—</span>
  const stepX = width / (days.length - 1)
  const path = days
    .map((d, i) => {
      const x = i * stepX
      const y = height - (d.calls / max) * (height - 2) - 1
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      role="img"
      aria-label="Daily call count"
    >
      <path
        d={path}
        fill="none"
        stroke="var(--mantine-color-blue-6)"
        strokeWidth={1.4}
      />
    </svg>
  )
}

// Fill missing days with zeros so the bars span the entire window
// (otherwise an idle stretch leaves a hole and the bars rescale wildly
// across renders).
function fillDays(rows: UsageDailyTotal[], daysBack: number): UsageDailyTotal[] {
  const byDay = new Map(rows.map((r) => [r.day, r]))
  const today = Math.floor(Math.floor(Date.now() / 1000) / SECONDS_PER_DAY) * SECONDS_PER_DAY
  const out: UsageDailyTotal[] = []
  for (let i = daysBack - 1; i >= 0; i--) {
    const day = today - i * SECONDS_PER_DAY
    out.push(
      byDay.get(day) ?? {
        day,
        calls: 0,
        reqTokens: 0,
        respTokens: 0,
        reqBytes: 0,
        respBytes: 0,
        errors: 0
      }
    )
  }
  return out
}

function fmtDate(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric'
  })
}
