import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Group, Select, Stack, Text, Title } from '@mantine/core'
import { USAGE_RANGE_LABEL, type UsageRange, type UsageResponse } from '@ctxlayer/shared'
import { fetchUsage } from '../lib/api'
import { explain } from '../lib/explain'
import { DailyBars, chartDaysForRange } from '../components/usage/charts'

/**
 * Personal usage dashboard. Self-scoped — the backend never exposes
 * other users' rows on this endpoint regardless of role.
 */

type Status =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: UsageResponse }

// Built from the shared range map so the options + order stay in sync.
const RANGE_OPTIONS = (Object.keys(USAGE_RANGE_LABEL) as UsageRange[]).map((r) => ({
  value: r,
  label: USAGE_RANGE_LABEL[r]
}))

export function Usage() {
  const [range, setRange] = useState<UsageRange>('30d')
  const [status, setStatus] = useState<Status>({ kind: 'loading' })
  const ctrlRef = useRef<AbortController | null>(null)

  const load = useCallback((r: UsageRange) => {
    ctrlRef.current?.abort()
    const ctrl = new AbortController()
    ctrlRef.current = ctrl
    setStatus({ kind: 'loading' })
    fetchUsage({ range: r }, ctrl.signal).then(
      (data) => {
        if (!ctrl.signal.aborted) setStatus({ kind: 'ready', data })
      },
      (err) => {
        if (ctrl.signal.aborted) return
        setStatus({ kind: 'error', message: explain(err) })
      }
    )
  }, [])

  useEffect(() => {
    load(range)
    return () => ctrlRef.current?.abort()
  }, [range, load])

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="center" wrap="nowrap">
        <Title order={2} fz={20} fw={600}>
          Your usage
        </Title>
        <Select
          size="xs"
          data={RANGE_OPTIONS}
          value={range}
          onChange={(v) => v && setRange(v as UsageRange)}
          w={150}
          allowDeselect={false}
        />
      </Group>

      {status.kind === 'error' && (
        <Alert color="red" variant="light" radius="sm">
          {status.message}
        </Alert>
      )}

      {status.kind === 'loading' && <Text c="dimmed">Loading…</Text>}

      {status.kind === 'ready' && <UsageBody data={status.data} range={range} />}
    </Stack>
  )
}

function UsageBody({ data, range }: { data: UsageResponse; range: UsageRange }) {
  const totals = data.dailyTotals.reduce(
    (acc, d) => ({
      calls: acc.calls + d.calls,
      reqTokens: acc.reqTokens + d.reqTokens,
      respTokens: acc.respTokens + d.respTokens,
      errors: acc.errors + d.errors
    }),
    { calls: 0, reqTokens: 0, respTokens: 0, errors: 0 }
  )
  const chartDays = chartDaysForRange(range, data.dailyTotals)

  return (
    <Stack gap="xl">
      <SummaryRow totals={totals} />
      <Panel
        title="Daily activity"
        subtitle={`Request tokens (violet) + response tokens (blue) per day. Red dot = day had errors.`}
      >
        {totals.calls === 0 ? (
          <Text c="dimmed" fz="sm">
            No tool calls in this period yet.
          </Text>
        ) : (
          <DailyBars rows={data.dailyTotals} daysBack={chartDays} />
        )}
      </Panel>
      <Panel title="Top tools">
        <ToolTable rows={data.topTools} />
      </Panel>
      <Panel title="Top upstreams">
        <UpstreamTable rows={data.topUpstreams} />
      </Panel>
    </Stack>
  )
}

function SummaryRow({
  totals
}: {
  totals: { calls: number; reqTokens: number; respTokens: number; errors: number }
}) {
  return (
    <Group gap="xl" wrap="wrap">
      <Stat label="Calls" value={totals.calls.toLocaleString()} />
      <Stat label="Request tokens" value={totals.reqTokens.toLocaleString()} />
      <Stat label="Response tokens" value={totals.respTokens.toLocaleString()} />
      <Stat
        label="Errors"
        value={totals.errors.toLocaleString()}
        accent={totals.errors > 0 ? 'red' : undefined}
      />
    </Group>
  )
}

export function Stat({
  label,
  value,
  accent
}: {
  label: string
  value: string
  accent?: 'red' | 'yellow'
}) {
  return (
    <div>
      <Text
        fz={10}
        fw={600}
        c="dimmed"
        style={{ textTransform: 'uppercase', letterSpacing: '0.06em' }}
      >
        {label}
      </Text>
      <Text fz={22} fw={600} c={accent === 'red' ? 'red' : undefined} style={{ lineHeight: 1.2 }}>
        {value}
      </Text>
    </div>
  )
}

export function Panel({
  title,
  subtitle,
  children
}: {
  title: string
  subtitle?: string
  children: React.ReactNode
}) {
  return (
    <div>
      <Text fz="sm" fw={600} mb={2}>
        {title}
      </Text>
      {subtitle && (
        <Text fz="xs" c="dimmed" mb="xs">
          {subtitle}
        </Text>
      )}
      {children}
    </div>
  )
}

export function ToolTable({
  rows,
  showResilience = false
}: {
  rows: Array<{
    tool: string
    upstreamId: string
    calls: number
    reqTokens: number
    respTokens: number
    errors: number
    timeouts: number
    truncations: number
  }>
  // Admin-only: surface the WI-5 timeout / truncation counts.
  showResilience?: boolean
}) {
  if (rows.length === 0) {
    return (
      <Text c="dimmed" fz="sm">
        No tools have been called yet.
      </Text>
    )
  }
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>Tool</th>
          <th style={{ textAlign: 'right' }}>Calls</th>
          <th style={{ textAlign: 'right' }}>Req tokens</th>
          <th style={{ textAlign: 'right' }}>Resp tokens</th>
          <th style={{ textAlign: 'right' }}>Errors</th>
          {showResilience && <th style={{ textAlign: 'right' }}>Timeouts</th>}
          {showResilience && <th style={{ textAlign: 'right' }}>Truncated</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={`${r.upstreamId}|${r.tool}`}>
            <td>
              <code style={{ fontSize: 12 }}>{r.tool}</code>
              {r.upstreamId === '' && (
                <Text component="span" fz="xs" c="dimmed" ml={6}>
                  built-in
                </Text>
              )}
            </td>
            <td style={{ textAlign: 'right' }}>{r.calls.toLocaleString()}</td>
            <td className="text-muted" style={{ textAlign: 'right' }}>
              {r.reqTokens.toLocaleString()}
            </td>
            <td className="text-muted" style={{ textAlign: 'right' }}>
              {r.respTokens.toLocaleString()}
            </td>
            <td
              className={r.errors > 0 ? undefined : 'text-muted'}
              style={{
                textAlign: 'right',
                color: r.errors > 0 ? 'var(--mantine-color-red-6)' : undefined
              }}
            >
              {r.errors.toLocaleString()}
            </td>
            {showResilience && (
              <td
                className={r.timeouts > 0 ? undefined : 'text-muted'}
                style={{
                  textAlign: 'right',
                  color: r.timeouts > 0 ? 'var(--mantine-color-orange-6)' : undefined
                }}
              >
                {r.timeouts.toLocaleString()}
              </td>
            )}
            {showResilience && (
              <td className="text-muted" style={{ textAlign: 'right' }}>
                {r.truncations.toLocaleString()}
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function UpstreamTable({
  rows,
  showResilience = false
}: {
  rows: Array<{
    upstreamId: string
    upstreamSlug: string | null
    upstreamName: string | null
    calls: number
    reqTokens: number
    respTokens: number
    errors: number
    timeouts: number
    truncations: number
  }>
  // Admin-only: surface the WI-5 timeout / truncation counts.
  showResilience?: boolean
}) {
  if (rows.length === 0) {
    return (
      <Text c="dimmed" fz="sm">
        No upstream traffic yet.
      </Text>
    )
  }
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>Upstream</th>
          <th style={{ textAlign: 'right' }}>Calls</th>
          <th style={{ textAlign: 'right' }}>Req tokens</th>
          <th style={{ textAlign: 'right' }}>Resp tokens</th>
          <th style={{ textAlign: 'right' }}>Errors</th>
          {showResilience && <th style={{ textAlign: 'right' }}>Timeouts</th>}
          {showResilience && <th style={{ textAlign: 'right' }}>Truncated</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.upstreamId || 'builtin'}>
            <td>
              {r.upstreamId === ''
                ? 'Built-in'
                : (r.upstreamName ?? r.upstreamSlug ?? <code>{r.upstreamId}</code>)}
            </td>
            <td style={{ textAlign: 'right' }}>{r.calls.toLocaleString()}</td>
            <td className="text-muted" style={{ textAlign: 'right' }}>
              {r.reqTokens.toLocaleString()}
            </td>
            <td className="text-muted" style={{ textAlign: 'right' }}>
              {r.respTokens.toLocaleString()}
            </td>
            <td
              style={{
                textAlign: 'right',
                color: r.errors > 0 ? 'var(--mantine-color-red-6)' : undefined
              }}
            >
              {r.errors.toLocaleString()}
            </td>
            {showResilience && (
              <td
                className={r.timeouts > 0 ? undefined : 'text-muted'}
                style={{
                  textAlign: 'right',
                  color: r.timeouts > 0 ? 'var(--mantine-color-orange-6)' : undefined
                }}
              >
                {r.timeouts.toLocaleString()}
              </td>
            )}
            {showResilience && (
              <td className="text-muted" style={{ textAlign: 'right' }}>
                {r.truncations.toLocaleString()}
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
