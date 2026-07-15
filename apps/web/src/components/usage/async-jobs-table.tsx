import { Badge, Group, Text } from '@mantine/core'
import type { UsageAsyncJobRow, UsageAsyncSummary } from '@ctxlayer/shared'
import { UserCell } from './user-cell'

/**
 * Async submit→poll analytics (WI-6) for the admin usage dashboard. A summary
 * badge row + the most-recent async jobs, sourced from the `async_jobs` table.
 * A tool opts into async by being on an upstream's `asyncTools` config
 * (Admin · Upstreams → Advanced). Rows are retained 30 days like the other
 * panels; the (heavy) result body is dropped after a day.
 */

const STATUS_COLOR: Record<string, string> = {
  done: 'green',
  running: 'blue',
  error: 'red'
}

function fmtTime(tsSec: number): string {
  try {
    return new Date(tsSec * 1000).toLocaleString()
  } catch {
    return String(tsSec)
  }
}

// Background run time. Async calls are minutes-scale, so a m/s split reads
// better than raw ms.
function fmtDuration(ms: number | null): string {
  if (ms == null) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

export function AsyncJobsTable({
  summary,
  jobs = [],
  showUser = false
}: {
  summary: UsageAsyncSummary
  jobs?: UsageAsyncJobRow[]
  // Admin dashboard sets this to attribute each job to its caller; the
  // personal view leaves it off (every row is the viewer).
  showUser?: boolean
}) {
  return (
    <>
      <Group gap="xs" mb="sm" wrap="wrap" align="center">
        <Badge variant="light" color="gray">
          {summary.total} submitted
        </Badge>
        <Badge variant="light" color="green">
          {summary.done} done
        </Badge>
        {summary.running > 0 && (
          <Badge variant="light" color="blue">
            {summary.running} running
          </Badge>
        )}
        {summary.error > 0 && (
          <Badge variant="light" color="red">
            {summary.error} error
          </Badge>
        )}
        {summary.timedOut > 0 && (
          <Badge variant="light" color="yellow">
            {summary.timedOut} timed out
          </Badge>
        )}
        {summary.avgDurationMs != null && (
          <Text fz="xs" c="dimmed">
            background run avg {fmtDuration(summary.avgDurationMs)} · max{' '}
            {fmtDuration(summary.maxDurationMs)}
          </Text>
        )}
      </Group>

      {jobs.length === 0 ? (
        <Text c="dimmed" fz="sm">
          No async tool jobs in this period. Tools opt in via an upstream&apos;s async-tools config
          (Admin · Upstreams → the upstream → Advanced).
        </Text>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Submitted</th>
              {showUser && <th>User</th>}
              <th>Tool</th>
              <th>Upstream</th>
              <th>Status</th>
              <th style={{ textAlign: 'right' }}>Duration</th>
              <th>Error</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id}>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <Text fz="xs" c="dimmed">
                    {fmtTime(j.createdAt)}
                  </Text>
                </td>
                {showUser && (
                  <td>
                    <UserCell userId={j.userId} email={j.userEmail} />
                  </td>
                )}
                <td>
                  <code style={{ fontSize: 12 }}>{j.tool}</code>
                </td>
                <td>
                  {j.upstreamSlug ? (
                    <code style={{ fontSize: 12 }}>{j.upstreamSlug}</code>
                  ) : (
                    <Text fz="xs" c="dimmed">
                      —
                    </Text>
                  )}
                </td>
                <td>
                  <Badge size="xs" variant="light" color={STATUS_COLOR[j.status] ?? 'gray'}>
                    {j.status}
                  </Badge>
                </td>
                <td style={{ textAlign: 'right' }}>{fmtDuration(j.durationMs)}</td>
                <td>
                  {j.errorCode ? (
                    <Badge
                      size="xs"
                      variant="light"
                      color={j.errorCode === 'timeout' ? 'yellow' : 'red'}
                    >
                      {j.errorCode}
                    </Badge>
                  ) : (
                    <Text fz="xs" c="dimmed">
                      —
                    </Text>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}
