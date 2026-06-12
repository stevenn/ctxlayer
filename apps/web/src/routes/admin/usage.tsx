import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Group, Select, Stack, Text, TextInput, Title } from '@mantine/core'
import { USAGE_RANGE_LABEL, type AdminUsageResponse, type UsageRange } from '@ctxlayer/shared'
import { fetchAdminUsage, searchUsers } from '../../lib/api'
import { explain as explainBase } from '../../lib/explain'
import { DailyBars, chartDaysForRange } from '../../components/usage/charts'
import {
  Panel,
  SummaryRow,
  sumDailyTotals,
  viewerOffsetSec,
  viewerTzLabel
} from '../../components/usage/summary'
import { ToolTable, UpstreamTable } from '../../components/usage/tables'

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

// Built from the shared range map so the options + order stay in sync.
const RANGE_OPTIONS = (Object.keys(USAGE_RANGE_LABEL) as UsageRange[]).map((r) => ({
  value: r,
  label: USAGE_RANGE_LABEL[r]
}))

type PickedUser = { id: string; email: string }

export function AdminUsage() {
  const [range, setRange] = useState<UsageRange>('30d')
  const [user, setUser] = useState<PickedUser | null>(null)
  const [upstreamId, setUpstreamId] = useState('')
  const [status, setStatus] = useState<Status>({ kind: 'loading' })
  const ctrlRef = useRef<AbortController | null>(null)

  const load = useCallback((opts: { range: UsageRange; userId: string; upstreamId: string }) => {
    ctrlRef.current?.abort()
    const ctrl = new AbortController()
    ctrlRef.current = ctrl
    setStatus({ kind: 'loading' })
    fetchAdminUsage(
      {
        range: opts.range,
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
  }, [])

  // Range + user select fire ~immediately; the upstream text filter debounces.
  useEffect(() => {
    const t = setTimeout(
      () => load({ range, userId: user?.id ?? '', upstreamId: upstreamId.trim() }),
      300
    )
    return () => clearTimeout(t)
  }, [range, user, upstreamId, load])

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
            value={range}
            onChange={(v) => v && setRange(v as UsageRange)}
            w={150}
            allowDeselect={false}
          />
          <UserPicker value={user} onChange={setUser} />
          <TextInput
            size="xs"
            placeholder="Filter by upstream id"
            value={upstreamId}
            onChange={(e) => setUpstreamId(e.currentTarget.value)}
            w={200}
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
          range={range}
          filterUserEmail={user?.email ?? ''}
          filterUpstreamId={upstreamId.trim()}
        />
      )}
    </Stack>
  )
}

/**
 * Admin per-user filter: type an email, pick a match. Searches `/api/users`
 * (email prefix) with a short debounce; keeps the selected user in the option
 * list so its label still renders after the search box is cleared.
 */
function UserPicker({
  value,
  onChange
}: {
  value: PickedUser | null
  onChange: (u: PickedUser | null) => void
}) {
  const [search, setSearch] = useState('')
  const [results, setResults] = useState<PickedUser[]>([])

  useEffect(() => {
    const q = search.trim()
    if (q.length < 2) {
      setResults([])
      return
    }
    const ctrl = new AbortController()
    const t = setTimeout(() => {
      searchUsers(q, ctrl.signal).then(
        (rows) => setResults(rows.map((r) => ({ id: r.id, email: r.email }))),
        () => {}
      )
    }, 250)
    return () => {
      clearTimeout(t)
      ctrl.abort()
    }
  }, [search])

  const data = useMemo(() => {
    const opts = results.map((u) => ({ value: u.id, label: u.email }))
    if (value && !opts.some((o) => o.value === value.id)) {
      opts.unshift({ value: value.id, label: value.email })
    }
    return opts
  }, [results, value])

  return (
    <Select
      size="xs"
      w={240}
      placeholder="Filter by user (email)"
      searchable
      clearable
      data={data}
      value={value?.id ?? null}
      searchValue={search}
      onSearchChange={setSearch}
      onChange={(id) => {
        if (!id) {
          onChange(null)
          return
        }
        const u = results.find((r) => r.id === id) ?? value
        onChange(u ? { id: u.id, email: u.email } : null)
      }}
      nothingFoundMessage={search.trim().length < 2 ? 'Type an email…' : 'No matches'}
    />
  )
}

function AdminUsageBody({
  data,
  range,
  filterUserEmail,
  filterUpstreamId
}: {
  data: AdminUsageResponse
  range: UsageRange
  filterUserEmail: string
  filterUpstreamId: string
}) {
  const totals = sumDailyTotals(data.dailyTotals)
  const offsetSec = viewerOffsetSec()
  const chartDays = chartDaysForRange(range, data.dailyTotals, offsetSec)

  return (
    <Stack gap="xl">
      <SummaryRow totals={totals} />

      {(filterUserEmail || filterUpstreamId) && (
        <Text fz="xs" c="dimmed">
          Filtered to{' '}
          {filterUserEmail && (
            <>
              user <strong>{filterUserEmail}</strong>
            </>
          )}
          {filterUserEmail && filterUpstreamId && ' · '}
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
              style={{
                textAlign: 'right',
                color: r.errors > 0 ? 'var(--mantine-color-red-6)' : undefined
              }}
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
