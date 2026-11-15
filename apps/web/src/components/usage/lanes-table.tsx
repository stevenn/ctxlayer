import { Badge, Group, Text } from '@mantine/core'
import { USAGE_LANE_LABEL, type UsageLane, type UsageLaneStats } from '@ctxlayer/shared'

/**
 * Protocol lanes for the admin usage dashboard: how much each MCP lane
 * carries, how it performs, and which clients are on it. `/mcp` is served by
 * two coexisting lanes — the session lane (2025-era clients) and the stateless
 * lane (2026-07-28 clients) — and this is where an operator compares them and
 * sees who still depends on which. Sourced from raw usage events, so it covers
 * at most the last 30 days whatever the selected range.
 */

const LANE_COLOR: Record<UsageLane, string> = {
  session: 'blue',
  stateless: 'teal'
}

/** Display name for a lane; `null` = events recorded before lanes were tracked. */
export function laneLabel(lane: string | null): string {
  if (lane == null) return 'Unknown (before lane tracking)'
  return (USAGE_LANE_LABEL as Record<string, string>)[lane] ?? lane
}

export function laneColor(lane: string | null): string {
  return lane == null ? 'gray' : ((LANE_COLOR as Record<string, string>)[lane] ?? 'gray')
}

function fmtMs(ms: number | null): string {
  if (ms == null) return '—'
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`
}

function fmtPct(part: number, whole: number): string {
  if (whole === 0) return '0%'
  const pct = (part / whole) * 100
  return pct > 0 && pct < 0.1 ? '<0.1%' : `${pct.toFixed(1)}%`
}

function fmtTime(tsSec: number | null): string {
  if (tsSec == null) return '—'
  try {
    return new Date(tsSec * 1000).toLocaleString()
  } catch {
    return String(tsSec)
  }
}

export function LanesTable({ lanes = [] }: { lanes?: UsageLaneStats[] }) {
  if (lanes.length === 0) {
    return (
      <Text c="dimmed" fz="sm">
        No tool calls in the last 30 days of this period.
      </Text>
    )
  }
  const totalCalls = lanes.reduce((n, l) => n + l.calls, 0)
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>Lane</th>
          <th style={{ textAlign: 'right' }}>Calls</th>
          <th style={{ textAlign: 'right' }}>Share</th>
          <th style={{ textAlign: 'right' }}>Users</th>
          <th style={{ textAlign: 'right' }}>Errors</th>
          <th style={{ textAlign: 'right' }}>Timeouts</th>
          <th style={{ textAlign: 'right' }}>Latency p50</th>
          <th style={{ textAlign: 'right' }}>p95</th>
          <th>Last call</th>
          <th>Clients</th>
        </tr>
      </thead>
      <tbody>
        {lanes.map((l) => (
          <tr key={l.lane ?? 'unknown'}>
            <td style={{ whiteSpace: 'nowrap' }}>
              <Badge size="sm" variant="light" color={laneColor(l.lane)}>
                {laneLabel(l.lane)}
              </Badge>
              {l.protocolVersions.length > 0 && (
                <Text fz={11} c="dimmed" mt={2}>
                  {l.protocolVersions.join(', ')}
                </Text>
              )}
            </td>
            <td style={{ textAlign: 'right' }}>{l.calls.toLocaleString()}</td>
            <td style={{ textAlign: 'right' }}>{fmtPct(l.calls, totalCalls)}</td>
            <td style={{ textAlign: 'right' }}>{l.users}</td>
            <td style={{ textAlign: 'right' }}>
              {l.errors.toLocaleString()}
              <Text component="span" fz={11} c="dimmed" ml={4}>
                {fmtPct(l.errors, l.calls)}
              </Text>
            </td>
            <td style={{ textAlign: 'right' }}>{l.timeouts.toLocaleString()}</td>
            <td style={{ textAlign: 'right' }}>{fmtMs(l.p50LatencyMs)}</td>
            <td style={{ textAlign: 'right' }}>{fmtMs(l.p95LatencyMs)}</td>
            <td style={{ whiteSpace: 'nowrap' }}>
              <Text fz="xs" c="dimmed">
                {fmtTime(l.lastSeen)}
              </Text>
            </td>
            <td>
              <Group gap={4} wrap="wrap">
                {l.clients.map((c) => (
                  <Badge
                    key={c.clientName ?? '∅'}
                    size="xs"
                    variant="outline"
                    color="gray"
                    title={`${c.calls.toLocaleString()} calls · ${c.users} user${c.users === 1 ? '' : 's'} · last ${fmtTime(c.lastSeen)}`}
                    style={{ textTransform: 'none' }}
                  >
                    {c.clientName ?? 'unnamed client'} · {c.calls.toLocaleString()}
                  </Badge>
                ))}
              </Group>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
