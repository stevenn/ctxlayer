import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Group, Select, Stack, Text, Title } from '@mantine/core'
import { USAGE_RANGE_LABEL, type UsageErrorsResponse, type UsageRange } from '@ctxlayer/shared'
import { explain } from '../../lib/explain'
import { useUsageRange } from '../../lib/use-usage-range'
import { ErrorsTable } from './errors-table'
import { Panel } from './summary'

/**
 * Shared body for the two Errors pages (/app/errors and /app/admin/errors).
 * The list used to be a panel inside the Usage dashboards; it cluttered the
 * screen and grew every dashboard payload, so it now has its own menu item
 * fed by the dedicated `/errors` endpoints. The range selection shares the
 * sibling usage dashboard's stored value (same `useUsageRange` scope), so
 * flipping between Usage and Errors keeps one consistent window.
 */

const RANGE_OPTIONS = (Object.keys(USAGE_RANGE_LABEL) as UsageRange[]).map((r) => ({
  value: r,
  label: USAGE_RANGE_LABEL[r]
}))

type Status =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: UsageErrorsResponse }

export function ErrorsPage({
  title,
  subtitle,
  scope,
  showUser,
  fetchErrors
}: {
  title: string
  subtitle: string
  scope: 'personal' | 'admin'
  showUser?: boolean
  fetchErrors: (
    opts: { range?: UsageRange },
    signal?: AbortSignal
  ) => Promise<UsageErrorsResponse>
}) {
  const [range, setRange] = useUsageRange(scope)
  const [status, setStatus] = useState<Status>({ kind: 'loading' })
  const ctrlRef = useRef<AbortController | null>(null)

  const load = useCallback(
    (r: UsageRange) => {
      ctrlRef.current?.abort()
      const ctrl = new AbortController()
      ctrlRef.current = ctrl
      setStatus({ kind: 'loading' })
      fetchErrors({ range: r }, ctrl.signal).then(
        (data) => {
          if (!ctrl.signal.aborted) setStatus({ kind: 'ready', data })
        },
        (err) => {
          if (ctrl.signal.aborted) return
          setStatus({ kind: 'error', message: explain(err) })
        }
      )
    },
    [fetchErrors]
  )

  useEffect(() => {
    load(range)
    return () => ctrlRef.current?.abort()
  }, [range, load])

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="center" wrap="nowrap">
        <Title order={2} fz={20} fw={600}>
          {title}
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

      {status.kind === 'ready' && (
        <Panel title="Failed tool calls" subtitle={subtitle}>
          <ErrorsTable rows={status.data.errors} range={range} showUser={showUser} />
        </Panel>
      )}
    </Stack>
  )
}
