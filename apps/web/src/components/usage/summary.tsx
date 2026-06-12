import { Group, Text } from '@mantine/core'
import type { UsageDailyTotal } from '@ctxlayer/shared'

/**
 * Shared bits between the personal (/app/usage) and admin
 * (/app/admin/usage) dashboards: the totals reduce, the headline
 * Stat row, and the titled Panel wrapper.
 */

export interface UsageTotals {
  calls: number
  reqTokens: number
  respTokens: number
  errors: number
}

/** Sum the daily-totals rows into one headline figure set. */
export function sumDailyTotals(rows: UsageDailyTotal[]): UsageTotals {
  return rows.reduce(
    (acc, d) => ({
      calls: acc.calls + d.calls,
      reqTokens: acc.reqTokens + d.reqTokens,
      respTokens: acc.respTokens + d.respTokens,
      errors: acc.errors + d.errors
    }),
    { calls: 0, reqTokens: 0, respTokens: 0, errors: 0 }
  )
}

// Viewer timezone, shared by both usage pages. `offsetSec` drives the
// day-bucketing; `label` (IANA zone) is shown in the chart legend so it's
// clear the day grid follows the viewer's local calendar.
export function viewerOffsetSec(): number {
  return -new Date().getTimezoneOffset() * 60
}
export function viewerTzLabel(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return 'local time'
  }
}

export function SummaryRow({ totals }: { totals: UsageTotals }) {
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
