import { useEffect, useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  Code,
  Drawer,
  Group,
  Stack,
  Text,
  TextInput,
  Title
} from '@mantine/core'
import type { AuditLogEntry } from '@ctxlayer/shared'
import { Section } from '../../components/admin-bits'
import { clickableRow } from '../../lib/a11y'
import { fetchAdminAudit } from '../../lib/api'
import { explain as explainBase } from '../../lib/explain'
import { absDateTime, relativeTime } from '../../lib/time'
import { usePagedLoad } from '../../lib/use-paged-load'

/**
 * Admin · Audit log viewer (M5 phase 3).
 *
 * Newest-first cursor-paginated table. Filters are applied server-side
 * (action prefix + actor id) and are debounced so each keystroke
 * doesn't fire a round-trip. Clicking a row opens a Drawer that
 * pretty-prints the row's `meta` JSON for the full story.
 */

const PAGE_SIZE = 50

export function AdminAudit() {
  const [actionFilter, setActionFilter] = useState('')
  const [actorFilter, setActorFilter] = useState('')
  const [selected, setSelected] = useState<AuditLogEntry | null>(null)

  // Debounced copies of the filters (300ms) — they drive the hook's deps,
  // so each keystroke doesn't fire a round-trip. Settling on unchanged
  // values is a no-op (Object.is bail-out), so no spurious refetch.
  const [debouncedAction, setDebouncedAction] = useState('')
  const [debouncedActor, setDebouncedActor] = useState('')
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedAction(actionFilter.trim())
      setDebouncedActor(actorFilter.trim())
    }, 300)
    return () => clearTimeout(t)
  }, [actionFilter, actorFilter])

  const { status, loadMore } = usePagedLoad<AuditLogEntry, number>(
    async ({ cursor, limit }, signal) => {
      const page = await fetchAdminAudit(
        {
          action: debouncedAction || undefined,
          actorId: debouncedActor || undefined,
          limit,
          before: cursor ?? undefined
        },
        signal
      )
      return { items: page.entries, next: page.nextBefore }
    },
    [debouncedAction, debouncedActor],
    { pageSize: PAGE_SIZE, explain }
  )

  return (
    <>
      <Group justify="space-between" align="center" mb="md" gap="md" wrap="wrap">
        <Title order={2} fz={20} fw={600}>
          Admin · Audit log
        </Title>
        <Group gap="xs">
          <TextInput
            size="xs"
            aria-label="Filter by action prefix"
            placeholder="Action prefix (e.g. doc., user., upstream.)"
            value={actionFilter}
            onChange={(e) => setActionFilter(e.currentTarget.value)}
            w={260}
          />
          <TextInput
            size="xs"
            aria-label="Filter by actor id"
            placeholder="Actor id"
            value={actorFilter}
            onChange={(e) => setActorFilter(e.currentTarget.value)}
            w={220}
          />
        </Group>
      </Group>

      {status.kind === 'error' && (
        <Alert color="red" variant="light" radius="sm" mb="md">
          {status.message}
        </Alert>
      )}

      {status.kind === 'loading' && <Text c="dimmed">Loading…</Text>}

      {status.kind === 'ready' && status.items.length === 0 && (
        <Text c="dimmed">
          No audit entries match the current filters.
          {(actionFilter || actorFilter) && ' Clear the filters above to see everything.'}
        </Text>
      )}

      {status.kind === 'ready' && status.items.length > 0 && (
        <>
          <table className="data-table">
            <thead>
              <tr>
                <th style={{ width: 170 }}>When</th>
                <th>Action</th>
                <th>Actor</th>
                <th>Target</th>
                <th>Summary</th>
              </tr>
            </thead>
            <tbody>
              {status.items.map((e) => (
                <tr key={e.id} {...clickableRow(() => setSelected(e))}>
                  <td className="text-muted" title={absDateTime(e.ts)}>
                    {relativeTime(e.ts)}
                  </td>
                  <td>
                    <ActionBadge action={e.action} />
                  </td>
                  <td className="text-muted">{e.actorEmail ?? e.actorId ?? '—'}</td>
                  <td className="text-muted">
                    {e.target ? <code style={{ fontSize: 11 }}>{e.target}</code> : '—'}
                  </td>
                  <td className="text-muted" style={{ maxWidth: 360 }}>
                    <MetaSummary meta={e.meta} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <Group justify="center" mt="md">
            {status.next !== null ? (
              <Button variant="default" size="xs" onClick={loadMore} loading={status.loadingMore}>
                Load more
              </Button>
            ) : (
              <Text fz="xs" c="dimmed">
                End of log ({status.items.length} entr
                {status.items.length === 1 ? 'y' : 'ies'}).
              </Text>
            )}
          </Group>
        </>
      )}

      {selected && <EntryDrawer entry={selected} onClose={() => setSelected(null)} />}
    </>
  )
}

// ----- Row drawer --------------------------------------------------------

function EntryDrawer({ entry, onClose }: { entry: AuditLogEntry; onClose: () => void }) {
  const metaJson = entry.meta != null ? JSON.stringify(entry.meta, null, 2) : null
  return (
    <Drawer
      opened
      onClose={onClose}
      title={`Audit · ${entry.action}`}
      position="right"
      size="md"
      padding="md"
    >
      <Stack gap="md">
        <Section title="When">
          <Text fz="sm">
            {absDateTime(entry.ts)}{' '}
            <Text component="span" fz="xs" c="dimmed">
              ({relativeTime(entry.ts)})
            </Text>
          </Text>
        </Section>
        <Section title="Actor">
          <Text fz="sm">
            {entry.actorEmail ?? (
              <Text component="span" c="dimmed">
                unknown email
              </Text>
            )}
          </Text>
          {entry.actorId && (
            <Text fz="xs" c="dimmed">
              <code>{entry.actorId}</code>
            </Text>
          )}
        </Section>
        <Section title="Target">
          {entry.target ? (
            <code style={{ fontSize: 12 }}>{entry.target}</code>
          ) : (
            <Text fz="xs" c="dimmed">
              No target.
            </Text>
          )}
        </Section>
        <Section title="Meta">
          {metaJson ? (
            <Code block style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>
              {metaJson}
            </Code>
          ) : (
            <Text fz="xs" c="dimmed">
              No metadata.
            </Text>
          )}
        </Section>
        <Section title="Entry id">
          <code style={{ fontSize: 11 }}>{entry.id}</code>
        </Section>
      </Stack>
    </Drawer>
  )
}

// ----- bits --------------------------------------------------------------

function ActionBadge({ action }: { action: string }) {
  const prefix = action.split('.')[0] ?? action
  const color = colorForPrefix(prefix)
  return (
    <Badge
      color={color}
      variant="light"
      size="sm"
      style={{ fontFamily: 'var(--mantine-font-family-monospace, monospace)' }}
    >
      {action}
    </Badge>
  )
}

function colorForPrefix(prefix: string): string {
  switch (prefix) {
    case 'user':
      return 'violet'
    case 'doc':
      return 'blue'
    case 'folder':
      return 'cyan'
    case 'upstream':
      return 'orange'
    case 'git_source':
      return 'lime'
    case 'team':
      return 'teal'
    case 'product':
      return 'grape'
    case 'role':
      return 'indigo'
    case 'credential':
      return 'red'
    default:
      return 'gray'
  }
}

function MetaSummary({ meta }: { meta: unknown }) {
  if (meta == null) return <span>—</span>
  if (typeof meta !== 'object') return <span>{String(meta)}</span>
  const entries = Object.entries(meta as Record<string, unknown>)
  if (entries.length === 0) return <span>{'{}'}</span>
  // First couple of keys give the reader the gist; click-through opens
  // the drawer with the full JSON.
  const preview = entries
    .slice(0, 3)
    .map(([k, v]) => `${k}=${formatScalar(v)}`)
    .join(' · ')
  const more = entries.length > 3 ? ` (+${entries.length - 3})` : ''
  return (
    <span style={{ fontFamily: 'var(--mantine-font-family-monospace, monospace)', fontSize: 11 }}>
      {preview}
      {more}
    </span>
  )
}

function formatScalar(v: unknown): string {
  if (v === null) return 'null'
  if (typeof v === 'string') {
    return v.length > 32 ? `"${v.slice(0, 30)}…"` : `"${v}"`
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return `[${v.length}]`
  if (typeof v === 'object') return '{…}'
  return String(v)
}

function explain(err: unknown): string {
  return explainBase(err, {
    403: 'Admin permission required.',
    400: (e) => {
      const body = e.body as { hint?: string } | null
      return (body && typeof body.hint === 'string' && body.hint) || 'Bad request.'
    }
  })
}
