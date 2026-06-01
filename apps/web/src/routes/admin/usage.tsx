import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Alert,
  Group,
  Select,
  Stack,
  Text,
  TextInput,
  Title
} from '@mantine/core'
import type { AdminUsageResponse } from '@ctxlayer/shared'
import { fetchAdminUsage } from '../../lib/api'
import { explain as explainBase } from '../../lib/explain'
import { DailyBars } from '../../components/usage/charts'
import {
  Panel,
  Stat,
  ToolTable,
  UpstreamTable
} from '../usage'

/**
 * Admin org-wide usage dashboard. Hits `/api/admin/usage` which is
 * gated by requireAdmin. Adds a top-users leaderboard + optional
 * user/upstream filters on top of the per-user surface.
 *
 * Filters debounce at 300ms; range select reloads immediately.
 */

type Status =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: AdminUsageResponse }

const RANGE_OPTIONS = [
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
  { value: '180', label: 'Last 180 days' }
]

export function AdminUsage() {
  const [days, setDays] = useState(30)
  const [userId, setUserId] = useState('')
  const [upstreamId, setUpstreamId] = useState('')
  const [status, setStatus] = useState<Status>({ kind: 'loading' })
  const ctrlRef = useRef<AbortController | null>(null)

  const load = useCallback(
    (opts: { days: number; userId: string; upstreamId: string }) => {
      ctrlRef.current?.abort()
      const ctrl = new AbortController()
      ctrlRef.current = ctrl
      setStatus({ kind: 'loading' })
      fetchAdminUsage(
        {
          days: opts.days,
          userId: opts.userId || undefined,
          upstreamId: opts.upstreamId || undefined
        },
        ctrl.signal
      ).then(
        (data) => {
          if (!ctrl.signal.aborted) setStatus({ kind: 'ready', data })
        },
        (err) => {
          if (ctrl.signal.aborted) return
          setStatus({ kind: 'error', message: explain(err) })
        }
      )
    },
    []
  )

  // Range select fires immediately; text filters debounce 300ms.
  useEffect(() => {
    const t = setTimeout(
      () => load({ days, userId: userId.trim(), upstreamId: upstreamId.trim() }),
      300
    )
    return () => clearTimeout(t)
  }, [days, userId, upstreamId, load])

  useEffect(() => () => ctrlRef.current?.abort(), [])

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="center" wrap="wrap" gap="md">
        <Title order={2} fz={20} fw={600}>
          Admin · Usage
        </Title>
        <Group gap="xs" wrap="wrap">
          <Select
            size="xs"
            data={RANGE_OPTIONS}
            value={String(days)}
            onChange={(v) => v && setDays(Number(v))}
            w={160}
            allowDeselect={false}
          />
          <TextInput
            size="xs"
            placeholder="Filter by user id"
            value={userId}
            onChange={(e) => setUserId(e.currentTarget.value)}
            w={220}
          />
          <TextInput
            size="xs"
            placeholder="Filter by upstream id"
            value={upstreamId}
            onChange={(e) => setUpstreamId(e.currentTarget.value)}
            w={220}
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
        <AdminUsageBody
          data={status.data}
          daysBack={days}
          filterUserId={userId.trim()}
          filterUpstreamId={upstreamId.trim()}
        />
      )}
    </Stack>
  )
}

function AdminUsageBody({
  data,
  daysBack,
  filterUserId,
  filterUpstreamId
}: {
  data: AdminUsageResponse
  daysBack: number
  filterUserId: string
  filterUpstreamId: string
}) {
  const totals = data.dailyTotals.reduce(
    (acc, d) => ({
      calls: acc.calls + d.calls,
      reqTokens: acc.reqTokens + d.reqTokens,
      respTokens: acc.respTokens + d.respTokens,
      errors: acc.errors + d.errors
    }),
    { calls: 0, reqTokens: 0, respTokens: 0, errors: 0 }
  )

  return (
    <Stack gap="xl">
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

      {(filterUserId || filterUpstreamId) && (
        <Text fz="xs" c="dimmed">
          Filtered to{' '}
          {filterUserId && (
            <>
              user <code>{filterUserId}</code>
            </>
          )}
          {filterUserId && filterUpstreamId && ' · '}
          {filterUpstreamId && (
            <>
              upstream <code>{filterUpstreamId}</code>
            </>
          )}
          .
        </Text>
      )}

      <Panel
        title="Daily activity"
        subtitle="Request tokens (violet) + response tokens (blue) per day. Red dot = day had errors."
      >
        {totals.calls === 0 ? (
          <Text c="dimmed" fz="sm">
            No tool calls in the last {daysBack} days yet.
          </Text>
        ) : (
          <DailyBars rows={data.dailyTotals} daysBack={daysBack} />
        )}
      </Panel>

      <Panel title="Top users">
        <UserTable rows={data.topUsers} />
      </Panel>
      <Panel title="Top tools">
        <ToolTable rows={data.topTools} showResilience />
      </Panel>
      <Panel title="Top upstreams">
        <UpstreamTable rows={data.topUpstreams} showResilience />
      </Panel>
    </Stack>
  )
}

function UserTable({
  rows
}: {
  rows: Array<{
    userId: string
    email: string | null
    calls: number
    reqTokens: number
    respTokens: number
    errors: number
  }>
}) {
  if (rows.length === 0) {
    return (
      <Text c="dimmed" fz="sm">
        No user activity in this window.
      </Text>
    )
  }
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>User</th>
          <th style={{ textAlign: 'right' }}>Calls</th>
          <th style={{ textAlign: 'right' }}>Req tokens</th>
          <th style={{ textAlign: 'right' }}>Resp tokens</th>
          <th style={{ textAlign: 'right' }}>Errors</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.userId}>
            <td>
              <div style={{ fontWeight: 500 }}>{r.email ?? <em>unknown</em>}</div>
              <Text component="div" fz="xs" c="dimmed">
                <code>{r.userId}</code>
              </Text>
            </td>
            <td style={{ textAlign: 'right' }}>{r.calls.toLocaleString()}</td>
            <td className="text-muted" style={{ textAlign: 'right' }}>
              {r.reqTokens.toLocaleString()}
            </td>
            <td className="text-muted" style={{ textAlign: 'right' }}>
              {r.respTokens.toLocaleString()}
            </td>
            <td
              style={{ textAlign: 'right', color: r.errors > 0 ? 'var(--mantine-color-red-6)' : undefined }}
            >
              {r.errors.toLocaleString()}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function explain(err: unknown): string {
  return explainBase(err, {
    403: 'Admin permission required.'
  })
}
