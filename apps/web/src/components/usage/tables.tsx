import { Text } from '@mantine/core'

/**
 * Numeric usage tables shared by the personal and admin dashboards.
 * `showResilience` (admin-only) adds the WI-5 timeout / truncation
 * columns.
 */

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
          <NumHeaders showResilience={showResilience} />
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
            <NumCells row={r} showResilience={showResilience} />
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
          <NumHeaders showResilience={showResilience} />
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
            <NumCells row={r} showResilience={showResilience} />
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// ----- shared columns -----------------------------------------------------

function NumHeaders({ showResilience }: { showResilience: boolean }) {
  return (
    <>
      <th style={{ textAlign: 'right' }}>Calls</th>
      <th style={{ textAlign: 'right' }}>Req tokens</th>
      <th style={{ textAlign: 'right' }}>Resp tokens</th>
      <th style={{ textAlign: 'right' }}>Errors</th>
      {showResilience && <th style={{ textAlign: 'right' }}>Timeouts</th>}
      {showResilience && <th style={{ textAlign: 'right' }}>Truncated</th>}
    </>
  )
}

function NumCells({
  row,
  showResilience
}: {
  row: {
    calls: number
    reqTokens: number
    respTokens: number
    errors: number
    timeouts: number
    truncations: number
  }
  showResilience: boolean
}) {
  return (
    <>
      <td style={{ textAlign: 'right' }}>{row.calls.toLocaleString()}</td>
      <td className="text-muted" style={{ textAlign: 'right' }}>
        {row.reqTokens.toLocaleString()}
      </td>
      <td className="text-muted" style={{ textAlign: 'right' }}>
        {row.respTokens.toLocaleString()}
      </td>
      <td
        className={row.errors > 0 ? undefined : 'text-muted'}
        style={{
          textAlign: 'right',
          color: row.errors > 0 ? 'var(--mantine-color-red-6)' : undefined
        }}
      >
        {row.errors.toLocaleString()}
      </td>
      {showResilience && (
        <td
          className={row.timeouts > 0 ? undefined : 'text-muted'}
          style={{
            textAlign: 'right',
            color: row.timeouts > 0 ? 'var(--mantine-color-orange-6)' : undefined
          }}
        >
          {row.timeouts.toLocaleString()}
        </td>
      )}
      {showResilience && (
        <td className="text-muted" style={{ textAlign: 'right' }}>
          {row.truncations.toLocaleString()}
        </td>
      )}
    </>
  )
}
