import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Group, Select, Stack, Text, Title } from '@mantine/core'
import { USAGE_RANGE_LABEL, type UsageRange, type UsageResponse } from '@ctxlayer/shared'
import { fetchUsage } from '../lib/api'
import { explain } from '../lib/explain'
import { DailyBars, chartDaysForRange } from '../components/usage/charts'
import {
  Panel,
  SummaryRow,
  sumDailyTotals,
  viewerOffsetSec,
  viewerTzLabel
} from '../components/usage/summary'
import { ToolTable, UpstreamTable } from '../components/usage/tables'
import { useUsageRange } from '../lib/use-usage-range'

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
  const [range, setRange] = useUsageRange('personal')
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
  const totals = sumDailyTotals(data.dailyTotals)
  const offsetSec = viewerOffsetSec()
  const chartDays = chartDaysForRange(range, data.dailyTotals, offsetSec)

  return (
    <Stack gap="xl">
      <SummaryRow totals={totals} />
      <Panel
        title="Daily activity"
        subtitle={`Request (violet) + response (blue) tokens per local day · ${viewerTzLabel()}. Red dot = day had errors.`}
      >
        {totals.calls === 0 ? (
          <Text c="dimmed" fz="sm">
            No tool calls in this period yet.
          </Text>
        ) : (
          <DailyBars rows={data.dailyTotals} daysBack={chartDays} offsetSec={offsetSec} />
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
