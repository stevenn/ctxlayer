import { useMemo, useState } from 'react'
import { Badge, Group, Select, Text } from '@mantine/core'
import type { UsageErrorRow, UsageRange } from '@ctxlayer/shared'

/**
 * Per-error drill-down for the usage dashboards. Renders the raw
 * `recentErrors` rows (status <> 'ok') the API returns alongside the
 * rollups — one row per failed tool call, most-recent first. Always
 * rendered so the panel reads like Top tools / Top upstreams; shows a
 * note when there's nothing to list. Two client-side filters (type +
 * origin) narrow what's already loaded, no refetch.
 *
 * Detail comes from `usage_events`, which retains 30 days, so when the
 * range dropdown asks for longer we caption that the totals count
 * further back than the rows listed here.
 */

const CODE_LABEL: Record<string, string> = {
  timeout: 'Timeout',
  upstream_5xx: 'Upstream 5xx',
  upstream_4xx: 'Upstream 4xx',
  upstream_auth: 'Auth',
  upstream_unreachable: 'Unreachable',
  upstream_error: 'Upstream error',
  local_error: 'Local error'
}

const CODE_COLOR: Record<string, string> = {
  timeout: 'yellow',
  upstream_5xx: 'red',
  upstream_4xx: 'orange',
  upstream_auth: 'red',
  upstream_unreachable: 'grape',
  upstream_error: 'gray',
  local_error: 'blue'
}

function codeLabel(code: string): string {
  return CODE_LABEL[code] ?? code
}

// Origin is derived from the row, not stored: a built-in/ctxlayer-side
// call has no upstream id, anything else involved a remote upstream.
function locusOf(row: UsageErrorRow): 'local' | 'remote' {
  return row.upstreamId === '' ? 'local' : 'remote'
}

function fmtTime(tsSec: number): string {
  try {
    return new Date(tsSec * 1000).toLocaleString()
  } catch {
    return String(tsSec)
  }
}

// Ranges longer than the 30-day raw retention — detail can't reach back
// as far as the rollup counts, so we caption the gap.
const EXCEEDS_RETENTION = new Set<UsageRange>(['90d', 'all'])

export function ErrorsTable({
  rows = [],
  range
}: {
  rows?: UsageErrorRow[]
  range: UsageRange
}) {
  const [code, setCode] = useState<string>('all')
  const [locus, setLocus] = useState<string>('all')

  const codeOptions = useMemo(() => {
    const present = Array.from(new Set(rows.map((r) => r.code))).sort()
    return [
      { value: 'all', label: 'All types' },
      ...present.map((c) => ({ value: c, label: codeLabel(c) }))
    ]
  }, [rows])

  const filtered = useMemo(
    () =>
      rows.filter(
        (r) =>
          (code === 'all' || r.code === code) && (locus === 'all' || locusOf(r) === locus)
      ),
    [rows, code, locus]
  )

  const longRange = EXCEEDS_RETENTION.has(range)

  return (
    <>
      <Group gap="xs" mb="xs">
        <Select
          size="xs"
          w={170}
          data={codeOptions}
          value={code}
          onChange={(v) => setCode(v ?? 'all')}
          allowDeselect={false}
          aria-label="Filter errors by type"
        />
        <Select
          size="xs"
          w={150}
          value={locus}
          onChange={(v) => setLocus(v ?? 'all')}
          allowDeselect={false}
          aria-label="Filter errors by origin"
          data={[
            { value: 'all', label: 'Local + remote' },
            { value: 'local', label: 'Local' },
            { value: 'remote', label: 'Remote' }
          ]}
        />
      </Group>

      {rows.length === 0 ? (
        <Text c="dimmed" fz="sm">
          {longRange ? 'No errors in the last 30 days.' : 'No errors in this period.'}
        </Text>
      ) : filtered.length === 0 ? (
        <Text c="dimmed" fz="sm">
          No errors match the current filters.
        </Text>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Tool</th>
              <th>Origin</th>
              <th>Type</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r, i) => (
              <tr key={`${r.ts}|${r.tool}|${i}`}>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <Text fz="xs" c="dimmed">
                    {fmtTime(r.ts)}
                  </Text>
                </td>
                <td>
                  <code style={{ fontSize: 12 }}>{r.tool}</code>
                  {r.upstreamId === '' && (
                    <Text component="span" fz="xs" c="dimmed" ml={6}>
                      built-in
                    </Text>
                  )}
                </td>
                <td>
                  <Badge size="xs" variant="light" color={locusOf(r) === 'local' ? 'blue' : 'grape'}>
                    {locusOf(r)}
                  </Badge>
                </td>
                <td>
                  <Badge size="xs" variant="light" color={CODE_COLOR[r.code] ?? 'gray'}>
                    {codeLabel(r.code)}
                  </Badge>
                </td>
                <td>
                  {r.message ? (
                    <Text
                      fz="xs"
                      style={{
                        fontFamily: 'var(--mantine-font-family-monospace)',
                        wordBreak: 'break-word'
                      }}
                    >
                      {r.message}
                    </Text>
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

      {longRange && rows.length > 0 && (
        <Text fz="xs" c="dimmed" mt="xs">
          Error detail is retained for 30 days — earlier failures still count in the totals above
          but aren't listed here.
        </Text>
      )}
    </>
  )
}
