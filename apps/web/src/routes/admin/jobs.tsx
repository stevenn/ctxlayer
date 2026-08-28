import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Badge,
  Code,
  Drawer,
  Group,
  Select,
  Stack,
  Text,
  Title
} from '@mantine/core'
import { USAGE_RANGE_LABEL, type AdminJobsResponse, type JobRunRow, type UsageRange } from '@ctxlayer/shared'
import { Section } from '../../components/admin-bits'
import { RunTimeline } from '../../components/jobs/run-timeline'
import { Panel } from '../../components/usage/summary'
import { clickableRow } from '../../lib/a11y'
import { fetchAdminJobs } from '../../lib/api'
import { explain } from '../../lib/explain'
import { absDateTime, relativeTime } from '../../lib/time'
import { useUsageRange } from '../../lib/use-usage-range'

/**
 * Admin · Jobs — execution history of the recurring batch jobs (cron
 * tasks + per-repo git-sync runs) from the `job_runs` ledger. The
 * timeline shows cadence + status per task; the table below is the
 * drill-down, and a row click opens the full summary/error drawer.
 */

const RANGE_OPTIONS = (Object.keys(USAGE_RANGE_LABEL) as UsageRange[]).map((r) => ({
  value: r,
  label: USAGE_RANGE_LABEL[r]
}))

type Status =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: AdminJobsResponse }

export function AdminJobs() {
  const [range, setRange] = useUsageRange('jobs')
  const [task, setTask] = useState<string>('all')
  const [status, setStatus] = useState<Status>({ kind: 'loading' })
  const [selected, setSelected] = useState<JobRunRow | null>(null)
  const ctrlRef = useRef<AbortController | null>(null)

  const load = useCallback((r: UsageRange) => {
    ctrlRef.current?.abort()
    const ctrl = new AbortController()
    ctrlRef.current = ctrl
    setStatus({ kind: 'loading' })
    fetchAdminJobs({ range: r }, ctrl.signal).then(
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

  const runs = status.kind === 'ready' ? status.data.runs : []
  const taskOptions = useMemo(() => {
    const present = [...new Set(runs.map((r) => r.task))].sort()
    return [{ value: 'all', label: 'All types' }, ...present.map((t) => ({ value: t, label: t }))]
  }, [runs])
  const filtered = useMemo(
    () => (task === 'all' ? runs : runs.filter((r) => r.task === task)),
    [runs, task]
  )

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="center" wrap="nowrap">
        <Title order={2} fz={20} fw={600}>
          Admin · Jobs
        </Title>
        <Group gap="xs" wrap="nowrap">
          <Select
            size="xs"
            data={taskOptions}
            value={task}
            onChange={(v) => setTask(v ?? 'all')}
            w={170}
            allowDeselect={false}
            aria-label="Filter by job type"
          />
          <Select
            size="xs"
            data={RANGE_OPTIONS}
            value={range}
            onChange={(v) => v && setRange(v as UsageRange)}
            w={150}
            allowDeselect={false}
          />
        </Group>
      </Group>

      {status.kind === 'error' && (
        <Alert color="red" variant="light" radius="sm">
          {status.message}
        </Alert>
      )}

      {status.kind === 'loading' && <Text c="dimmed">Loading…</Text>}

      {status.kind === 'ready' && (
        <>
          <Panel
            title="Run timeline"
            subtitle="One lane per job, one mark per run. Hover a mark for its summary; click for the full detail."
          >
            <RunTimeline runs={filtered} range={range} onSelect={setSelected} />
          </Panel>

          <Panel title="Runs" subtitle="Newest first. Click a row for the full summary and error detail.">
            {filtered.length === 0 ? (
              <Text c="dimmed" fz="sm">
                No runs recorded in this period.
              </Text>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th style={{ width: 150 }}>When</th>
                    <th>Task</th>
                    <th style={{ width: 90, textAlign: 'right' }}>Duration</th>
                    <th style={{ width: 80 }}>Status</th>
                    <th>Summary</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => (
                    <tr key={r.id} {...clickableRow(() => setSelected(r))}>
                      <td className="text-muted" title={absDateTime(r.startedAt)}>
                        {relativeTime(r.startedAt)}
                      </td>
                      <td>
                        <Badge
                          variant="light"
                          size="sm"
                          color="gray"
                          style={{ fontFamily: 'var(--mantine-font-family-monospace, monospace)' }}
                        >
                          {r.task}
                        </Badge>
                      </td>
                      <td className="text-muted" style={{ textAlign: 'right' }}>
                        {formatDuration(r.durationMs)}
                      </td>
                      <td>
                        <StatusBadge status={r.status} />
                      </td>
                      <td
                        className="text-muted"
                        style={{
                          maxWidth: 380,
                          fontFamily: 'var(--mantine-font-family-monospace, monospace)',
                          fontSize: 11
                        }}
                      >
                        {r.error ? truncate(r.error, 80) : summaryPreview(r.summary)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        </>
      )}

      {selected && <RunDrawer run={selected} onClose={() => setSelected(null)} />}
    </Stack>
  )
}

function StatusBadge({ status }: { status: JobRunRow['status'] }) {
  const color = status === 'ok' ? 'green' : status === 'partial' ? 'yellow' : 'red'
  return (
    <Badge color={color} variant="light" size="sm">
      {status}
    </Badge>
  )
}

function RunDrawer({ run, onClose }: { run: JobRunRow; onClose: () => void }) {
  return (
    <Drawer
      opened
      onClose={onClose}
      title={`Run · ${run.task}`}
      position="right"
      size="md"
      padding="md"
    >
      <Stack gap="md">
        <Section title="When">
          <Text fz="sm">
            {absDateTime(run.startedAt)}{' '}
            <Text component="span" fz="xs" c="dimmed">
              ({relativeTime(run.startedAt)}) · {formatDuration(run.durationMs)}
            </Text>
          </Text>
        </Section>
        <Section title="Status">
          <StatusBadge status={run.status} />
        </Section>
        <Section title="Summary">
          {run.summary ? (
            <Code block style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>
              {JSON.stringify(run.summary, null, 2)}
            </Code>
          ) : (
            <Text fz="xs" c="dimmed">
              No summary recorded.
            </Text>
          )}
        </Section>
        <Section title="Error">
          {run.error ? (
            <Code block style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>
              {run.error}
            </Code>
          ) : (
            <Text fz="xs" c="dimmed">
              No error.
            </Text>
          )}
        </Section>
        <Section title="Run id">
          <code style={{ fontSize: 11 }}>{run.id}</code>
        </Section>
      </Stack>
    </Drawer>
  )
}

function summaryPreview(summary: Record<string, unknown> | null): string {
  if (!summary) return '—'
  const parts = Object.entries(summary)
    .slice(0, 4)
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
  const more = Object.keys(summary).length > 4 ? ` (+${Object.keys(summary).length - 4})` : ''
  return parts.join(' · ') + more
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}
