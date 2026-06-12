import { useEffect, useRef, useState } from 'react'
import {
  USAGE_RANGE_DAYS,
  localDayIndex,
  rollupLocalDayIndex,
  type UsageDailyTotal,
  type UsageRange
} from '@ctxlayer/shared'

/**
 * Inline SVG charts for the M6 usage pages. Hand-rolled to avoid
 * pulling in recharts / mantine-charts and the ~100KB they'd add.
 *
 * `DailyBars` is responsive: it measures its container with a
 * ResizeObserver and renders the SVG at the real pixel width so
 * bars and axes scale naturally to whatever column it sits in.
 * X-tick density adapts to the selected period (every day for
 * 7-day view, ~every 5 days for 30, ~every 15 for 90, ~every 30
 * for 180+).
 */

const SECONDS_PER_DAY = 86400

// Plot-area gutters for axes.
const M_LEFT = 48
const M_BOTTOM = 24
// Top gutter reserves room for the per-bar data labels above the tallest bar.
const M_TOP = 20
const M_RIGHT = 8
const DEFAULT_HEIGHT = 220

interface DailyBarsProps {
  rows: UsageDailyTotal[]
  daysBack: number
  offsetSec: number
  height?: number
}

export function DailyBars({ rows, daysBack, offsetSec, height = DEFAULT_HEIGHT }: DailyBarsProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    // Seed with the current width so first paint isn't blank.
    setWidth(el.clientWidth)
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0
      if (w > 0) setWidth(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    <div ref={containerRef} style={{ width: '100%' }}>
      {width > 0 && (
        <Bars
          rows={rows}
          daysBack={daysBack}
          offsetSec={offsetSec}
          width={width}
          height={height}
        />
      )}
    </div>
  )
}

function Bars({
  rows,
  daysBack,
  offsetSec,
  width,
  height
}: {
  rows: UsageDailyTotal[]
  daysBack: number
  offsetSec: number
  width: number
  height: number
}) {
  const days = fillDays(rows, daysBack, offsetSec)
  const rawMax = Math.max(1, ...days.map((d) => d.reqTokens + d.respTokens))
  const maxTokens = niceCeil(rawMax)
  const plotW = Math.max(0, width - M_LEFT - M_RIGHT)
  const plotH = Math.max(0, height - M_TOP - M_BOTTOM)
  const barWidth = plotW / Math.max(1, days.length)
  // Tighten bar padding for very narrow days (long periods), keep
  // breathing room when there's space.
  const padX = barWidth >= 8 ? 1.5 : barWidth >= 3 ? 0.5 : 0

  const yTicks = niceTicks(maxTokens, 4)
  const xTickIdx = pickXTickIndices(days.length, daysBack)

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      style={{ display: 'block' }}
      role="img"
      aria-label="Daily request + response tokens"
    >
      {/* horizontal grid + Y tick labels */}
      {yTicks.map((v) => {
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

      {/* X ticks + labels */}
      {xTickIdx.map((i) => {
        const d = days[i]!
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
              {fmtDate(d.day)} — {d.calls} call{d.calls === 1 ? '' : 's'}, req {d.reqTokens} tok,
              resp {d.respTokens} tok
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
            {/* Data label: per-day total tokens, shown only when bars are
                wide enough to fit it (short windows) so dense charts stay
                readable. Clamped below the top gutter for tall bars. */}
            {barWidth >= 30 && d.reqTokens + d.respTokens > 0 && (
              <text
                x={x + barWidth / 2}
                y={Math.max(12, yTop - 7)}
                textAnchor="middle"
                fontSize={9}
                fontWeight={500}
                fill="var(--text-dim, #888)"
              >
                {fmtNum(d.reqTokens + d.respTokens)}
              </text>
            )}
          </g>
        )
      })}
    </svg>
  )
}

/**
 * Number of day-columns the chart should render for a range. Fixed ranges
 * use their span; `all` spans from the earliest data day to today (capped at
 * a year so one very old row can't explode the bar count).
 */
export function chartDaysForRange(
  range: UsageRange,
  rows: UsageDailyTotal[],
  offsetSec: number
): number {
  const fixed = USAGE_RANGE_DAYS[range]
  if (fixed != null) return fixed
  if (rows.length === 0) return 1
  const todayIndex = localDayIndex(Math.floor(Date.now() / 1000), offsetSec)
  const earliestIndex = Math.min(...rows.map((r) => rollupLocalDayIndex(r.day, offsetSec)))
  return Math.max(1, Math.min(todayIndex - earliestIndex + 1, 365))
}

// Decide which day-indices get an X-axis label. Always include the
// first and last; in between, pick a stride that produces ~8 labels
// max, with short windows (≤14 days) labeling every day so the user
// sees daily granularity at small periods.
function pickXTickIndices(daysCount: number, daysBack: number): number[] {
  if (daysCount === 0) return []
  if (daysCount === 1) return [0]
  if (daysBack <= 14) return Array.from({ length: daysCount }, (_, i) => i)
  const targetLabels = 8
  const stride = Math.max(1, Math.round((daysCount - 1) / (targetLabels - 1)))
  const out = new Set<number>([0, daysCount - 1])
  for (let i = stride; i < daysCount - stride; i += stride) out.add(i)
  return [...out].sort((a, b) => a - b)
}

// Fill missing days with zeros so the bars span the entire window
// (otherwise an idle stretch leaves a hole and the bars rescale wildly
// across renders).
function fillDays(rows: UsageDailyTotal[], daysBack: number, offsetSec: number): UsageDailyTotal[] {
  // Bucket each UTC-day rollup by the local date it mostly covers, then fill
  // the window with the viewer's local days. The emitted `day` is the UTC
  // instant of that local midnight, so the local-TZ date formatters below
  // render the correct local date for each bar.
  const byIndex = new Map(rows.map((r) => [rollupLocalDayIndex(r.day, offsetSec), r]))
  const todayIndex = localDayIndex(Math.floor(Date.now() / 1000), offsetSec)
  const out: UsageDailyTotal[] = []
  for (let i = daysBack - 1; i >= 0; i--) {
    const idx = todayIndex - i
    const day = idx * SECONDS_PER_DAY - offsetSec
    const r = byIndex.get(idx)
    out.push(
      r
        ? { ...r, day }
        : { day, calls: 0, reqTokens: 0, respTokens: 0, reqBytes: 0, respBytes: 0, errors: 0 }
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
  return new Date(unixSec * 1000).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric'
  })
}
