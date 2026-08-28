import { useEffect, useRef, useState } from 'react'
import { Group, Text } from '@mantine/core'
import { USAGE_RANGE_DAYS, type JobRunRow, type UsageRange } from '@ctxlayer/shared'

/**
 * Per-task run timeline for Admin · Jobs: one lane per task, one mark per
 * recorded run positioned on the time axis — cadence gaps and error
 * clusters are visible at a glance, which the runs table can't show.
 *
 * Hand-rolled inline SVG like `usage/charts.tsx` (no chart lib).
 * Status is encoded by color AND shape (dataviz rule: status never rides
 * color alone — validated palette green-9/yellow-6/red-8, protan ΔE 18.7):
 * ok = filled circle, partial = diamond, error = ×. Marks carry a 2px
 * surface ring so overlapping runs stay separable; hover = native SVG
 * <title> tooltip (the app idiom); click opens the run drawer.
 */

const LANE_H = 30
const M_LEFT = 150 // task label gutter
const M_RIGHT = 84 // per-lane stat gutter
const M_TOP = 8
const M_BOTTOM = 22
const SECONDS_PER_DAY = 86400

const STATUS_COLOR: Record<JobRunRow['status'], string> = {
  ok: 'var(--mantine-color-green-9, #2b8a3e)',
  partial: 'var(--mantine-color-yellow-6, #fab005)',
  error: 'var(--mantine-color-red-8, #e03131)'
}
const SURFACE_RING = 'var(--mantine-color-body, #fff)'

export function RunTimeline({
  runs,
  range,
  onSelect
}: {
  runs: JobRunRow[]
  range: UsageRange
  onSelect: (run: JobRunRow) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
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
      {width > 0 && <Lanes runs={runs} range={range} width={width} onSelect={onSelect} />}
      <Legend />
    </div>
  )
}

function Lanes({
  runs,
  range,
  width,
  onSelect
}: {
  runs: JobRunRow[]
  range: UsageRange
  width: number
  onSelect: (run: JobRunRow) => void
}) {
  const now = Math.floor(Date.now() / 1000)
  const rangeDays = USAGE_RANGE_DAYS[range]
  const oldest = runs.length ? Math.min(...runs.map((r) => r.startedAt)) : now - SECONDS_PER_DAY
  // 'all' has no fixed window — span from the oldest recorded run.
  const start = rangeDays ? now - rangeDays * SECONDS_PER_DAY : Math.min(oldest, now - SECONDS_PER_DAY)
  const span = Math.max(1, now - start)

  const tasks = [...new Set(runs.map((r) => r.task))].sort()
  const height = M_TOP + Math.max(1, tasks.length) * LANE_H + M_BOTTOM
  const plotW = Math.max(0, width - M_LEFT - M_RIGHT)
  const x = (ts: number) => M_LEFT + ((ts - start) / span) * plotW

  const ticks = timeTicks(start, now)

  if (runs.length === 0) {
    return (
      <Text c="dimmed" fz="sm">
        No recorded runs in this period yet — the ledger starts collecting from this deploy on.
      </Text>
    )
  }

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      style={{ display: 'block' }}
      role="img"
      aria-label="Job runs per task over time"
    >
      {/* recessive vertical time grid + tick labels */}
      {ticks.map((t) => (
        <g key={`t-${t.ts}`}>
          <line
            x1={x(t.ts)}
            x2={x(t.ts)}
            y1={M_TOP}
            y2={height - M_BOTTOM}
            stroke="var(--border, #2a2a2a)"
            strokeWidth={0.5}
            opacity={0.5}
          />
          <text
            x={x(t.ts)}
            y={height - 6}
            textAnchor="middle"
            fontSize={10}
            fill="var(--text-dim, #888)"
          >
            {t.label}
          </text>
        </g>
      ))}

      {tasks.map((task, i) => {
        const laneY = M_TOP + i * LANE_H + LANE_H / 2
        const laneRuns = runs.filter((r) => r.task === task)
        const okCount = laneRuns.filter((r) => r.status === 'ok').length
        return (
          <g key={task}>
            <line
              x1={M_LEFT}
              x2={width - M_RIGHT}
              y1={laneY}
              y2={laneY}
              stroke="var(--border, #2a2a2a)"
              strokeWidth={0.5}
              opacity={0.35}
            />
            <text
              x={M_LEFT - 10}
              y={laneY + 3.5}
              textAnchor="end"
              fontSize={11}
              fontFamily="var(--mantine-font-family-monospace, monospace)"
              fill="var(--text, #ddd)"
            >
              {task}
            </text>
            <text
              x={width - M_RIGHT + 10}
              y={laneY + 3.5}
              fontSize={10}
              fill="var(--text-dim, #888)"
            >
              {laneRuns.length} run{laneRuns.length === 1 ? '' : 's'} ·{' '}
              {Math.round((okCount / laneRuns.length) * 100)}%
            </text>
            {laneRuns.map((r) => (
              <RunMark key={r.id} run={r} cx={x(r.startedAt)} cy={laneY} onSelect={onSelect} />
            ))}
          </g>
        )
      })}
    </svg>
  )
}

function RunMark({
  run,
  cx,
  cy,
  onSelect
}: {
  run: JobRunRow
  cx: number
  cy: number
  onSelect: (run: JobRunRow) => void
}) {
  const color = STATUS_COLOR[run.status]
  const tip = [
    new Date(run.startedAt * 1000).toLocaleString(),
    `${run.task} · ${run.status} · ${run.durationMs}ms`,
    run.summary ? summaryLine(run.summary) : null,
    run.error ? `error: ${run.error.slice(0, 200)}` : null
  ]
    .filter(Boolean)
    .join('\n')

  return (
    // Pointer affordance only — the runs table below is the keyboard-
    // accessible path to the same drawer (clickableRow).
    <g onClick={() => onSelect(run)} style={{ cursor: 'pointer' }}>
      <title>{tip}</title>
      {/* invisible hit target well above mark size */}
      <circle cx={cx} cy={cy} r={10} fill="transparent" />
      {run.status === 'ok' && (
        <circle cx={cx} cy={cy} r={4.5} fill={color} stroke={SURFACE_RING} strokeWidth={1.5} />
      )}
      {run.status === 'partial' && (
        <rect
          x={cx - 4.5}
          y={cy - 4.5}
          width={9}
          height={9}
          transform={`rotate(45 ${cx} ${cy})`}
          fill={color}
          stroke={SURFACE_RING}
          strokeWidth={1.5}
        />
      )}
      {run.status === 'error' && (
        <g stroke={color} strokeWidth={2.5} strokeLinecap="round">
          {/* surface ring behind the × so it reads on top of neighbours */}
          <g stroke={SURFACE_RING} strokeWidth={4.5}>
            <line x1={cx - 4.5} y1={cy - 4.5} x2={cx + 4.5} y2={cy + 4.5} />
            <line x1={cx - 4.5} y1={cy + 4.5} x2={cx + 4.5} y2={cy - 4.5} />
          </g>
          <line x1={cx - 4.5} y1={cy - 4.5} x2={cx + 4.5} y2={cy + 4.5} />
          <line x1={cx - 4.5} y1={cy + 4.5} x2={cx + 4.5} y2={cy - 4.5} />
        </g>
      )}
    </g>
  )
}

function Legend() {
  return (
    <Group gap="md" mt={6}>
      <LegendItem label="ok">
        <circle cx={7} cy={7} r={4.5} fill={STATUS_COLOR.ok} />
      </LegendItem>
      <LegendItem label="partial">
        <rect x={2.5} y={2.5} width={9} height={9} transform="rotate(45 7 7)" fill={STATUS_COLOR.partial} />
      </LegendItem>
      <LegendItem label="error">
        <g stroke={STATUS_COLOR.error} strokeWidth={2.5} strokeLinecap="round">
          <line x1={3} y1={3} x2={11} y2={11} />
          <line x1={3} y1={11} x2={11} y2={3} />
        </g>
      </LegendItem>
    </Group>
  )
}

function LegendItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Group gap={5} align="center">
      <svg width={14} height={14} role="img" aria-label={`${label} mark`}>
        {children}
      </svg>
      <Text fz="xs" c="dimmed">
        {label}
      </Text>
    </Group>
  )
}

/** ~5 evenly spaced ticks labeled with the local short date. */
function timeTicks(start: number, end: number): Array<{ ts: number; label: string }> {
  const n = 5
  const out: Array<{ ts: number; label: string }> = []
  for (let i = 0; i <= n; i++) {
    const ts = start + ((end - start) * i) / n
    out.push({
      ts,
      label: new Date(ts * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    })
  }
  return out
}

function summaryLine(summary: Record<string, unknown>): string {
  return Object.entries(summary)
    .slice(0, 5)
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(' · ')
}
