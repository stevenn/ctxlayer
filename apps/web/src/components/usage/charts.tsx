import type { UsageDailyTotal } from '@ctxlayer/shared'

/**
 * Inline SVG charts used by the M6 usage pages. Hand-rolled to avoid
 * pulling in recharts / mantine-charts and the ~100KB they'd add.
 * Two views:
 *
 *   - `DailyBars` — one bar per day for the last N days, with a Y axis
 *     (request + response tokens) and an X axis with date ticks at
 *     ~6 evenly-spaced positions across the window.
 *   - `Sparkline` — line over the daily call count for compact
 *     embedding inside leaderboard rows or summary headers.
 */

const SECONDS_PER_DAY = 86400

// Left gutter for Y-axis labels, bottom for X-axis labels.
const M_LEFT = 44
const M_BOTTOM = 22
const M_TOP = 8
const M_RIGHT = 8

interface Sized {
  width?: number
  height?: number
}

export function DailyBars({
  rows,
  daysBack,
  width = 720,
  height = 200
}: { rows: UsageDailyTotal[]; daysBack: number } & Sized) {
  const days = fillDays(rows, daysBack)
  const rawMax = Math.max(1, ...days.map((d) => d.reqTokens + d.respTokens))
  // Round up to a "nice" axis max so tick labels read cleanly.
  const maxTokens = niceCeil(rawMax)
  const plotW = width - M_LEFT - M_RIGHT
  const plotH = height - M_TOP - M_BOTTOM
  const barWidth = plotW / days.length
  const padX = 1

  const ticks = niceTicks(maxTokens, 4) // 4 horizontal grid + label lines

  // Pick ~6 evenly-spaced X labels (first, last, ~4 in the middle).
  const xLabelStride = Math.max(1, Math.ceil(days.length / 6))
  const xLabels = days
    .map((d, i) => ({ d, i }))
    .filter(({ i }) => i === 0 || i === days.length - 1 || i % xLabelStride === 0)

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      style={{ display: 'block', maxWidth: '100%' }}
      role="img"
      aria-label="Daily request + response tokens"
    >
      {/* horizontal grid + Y tick labels */}
      {ticks.map((v) => {
        const y = M_TOP + plotH - (v / maxTokens) * plotH
        return (
          <g key={`yt-${v}`}>
            <line
              x1={M_LEFT}
              x2={width - M_RIGHT}
              y1={y}
              y2={y}
              stroke="var(--border, #2a2a2a)"
              strokeWidth={0.5}
              opacity={v === 0 ? 1 : 0.5}
            />
            <text
              x={M_LEFT - 6}
              y={y + 3}
              textAnchor="end"
              fontSize={10}
              fill="var(--text-dim, #888)"
            >
              {fmtNum(v)}
            </text>
          </g>
        )
      })}

      {/* X tick labels (rotated 30° so they don't collide) */}
      {xLabels.map(({ d, i }) => {
        const cx = M_LEFT + (i + 0.5) * barWidth
        return (
          <g key={`xt-${d.day}`}>
            <line
              x1={cx}
              x2={cx}
              y1={M_TOP + plotH}
              y2={M_TOP + plotH + 3}
              stroke="var(--border, #2a2a2a)"
              strokeWidth={0.5}
            />
            <text
              x={cx}
              y={M_TOP + plotH + 14}
              textAnchor="middle"
              fontSize={10}
              fill="var(--text-dim, #888)"
            >
              {fmtDateShort(d.day)}
            </text>
          </g>
        )
      })}

      {/* bars */}
      {days.map((d, i) => {
        const totalH = ((d.reqTokens + d.respTokens) / maxTokens) * plotH
        const reqH = (d.reqTokens / maxTokens) * plotH
        const x = M_LEFT + i * barWidth
        const yBaseline = M_TOP + plotH
        const yTop = yBaseline - totalH
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
              y={yBaseline - reqH}
              width={Math.max(0, barWidth - 2 * padX)}
              height={Math.max(0, reqH)}
              fill="var(--mantine-color-violet-5)"
            />
            {d.errors > 0 && (
              <circle
                cx={x + barWidth / 2}
                cy={M_TOP + 4}
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

// Round a max value up to a "nice" number so axis labels read cleanly.
// e.g. 3050 → 4000, 12000 → 15000, 87 → 100.
function niceCeil(raw: number): number {
  if (raw <= 0) return 1
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const norm = raw / mag
  let nice: number
  if (norm <= 1) nice = 1
  else if (norm <= 2) nice = 2
  else if (norm <= 2.5) nice = 2.5
  else if (norm <= 5) nice = 5
  else nice = 10
  return nice * mag
}

// Generate `count`+1 evenly-spaced tick values from 0 to max inclusive.
function niceTicks(max: number, count: number): number[] {
  const step = max / count
  const out: number[] = []
  for (let i = 0; i <= count; i++) out.push(Math.round(i * step))
  return out
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1) + 'k'
  return String(n)
}

function fmtDate(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric'
  })
}

function fmtDateShort(unixSec: number): string {
  // Compact "May 26" form for axis ticks — same as fmtDate today
  // but kept separate so we can later switch to numeric "5/26" or
  // weekday-only without affecting the tooltip text.
  return new Date(unixSec * 1000).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric'
  })
}
