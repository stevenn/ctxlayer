import { useCallback, useEffect, useRef, useState } from 'react'
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
import { fetchAdminAudit } from '../../lib/api'
import { explain as explainBase } from '../../lib/explain'

/**
 * Admin · Audit log viewer (M5 phase 3).
 *
 * Newest-first cursor-paginated table. Filters are applied server-side
 * (action prefix + actor id) and are debounced so each keystroke
 * doesn't fire a round-trip. Clicking a row opens a Drawer that
 * pretty-prints the row's `meta` JSON for the full story.
 */

const PAGE_SIZE = 50

type Status =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | {
      kind: 'ready'
      entries: AuditLogEntry[]
      nextBefore: number | null
      loadingMore: boolean
    }

export function AdminAudit() {
  const [status, setStatus] = useState<Status>({ kind: 'loading' })
  const [actionFilter, setActionFilter] = useState('')
  const [actorFilter, setActorFilter] = useState('')
  const [selected, setSelected] = useState<AuditLogEntry | null>(null)

  // Debounced + abort-on-supersede load. A ref carries the latest
  // controller so a fresh filter cancels the in-flight request.
  const ctrlRef = useRef<AbortController | null>(null)

  const load = useCallback(
    async (filters: { action: string; actorId: string }) => {
      ctrlRef.current?.abort()
      const ctrl = new AbortController()
      ctrlRef.current = ctrl
      setStatus({ kind: 'loading' })
      try {
        const page = await fetchAdminAudit(
          {
            action: filters.action || undefined,
            actorId: filters.actorId || undefined,
            limit: PAGE_SIZE
          },
          ctrl.signal
        )
        if (ctrl.signal.aborted) return
        setStatus({
          kind: 'ready',
          entries: page.entries,
          nextBefore: page.nextBefore,
          loadingMore: false
        })
      } catch (err) {
        if (ctrl.signal.aborted) return
        setStatus({ kind: 'error', message: explain(err) })
      }
    },
    []
  )

  // Initial load.
  useEffect(() => {
    load({ action: '', actorId: '' })
    return () => ctrlRef.current?.abort()
  }, [load])

  // Debounced filter changes (300ms).
  useEffect(() => {
    const t = setTimeout(
      () => load({ action: actionFilter.trim(), actorId: actorFilter.trim() }),
      300
    )
    return () => clearTimeout(t)
  }, [actionFilter, actorFilter, load])

  async function loadMore() {
    if (status.kind !== 'ready' || status.nextBefore === null || status.loadingMore) return
    setStatus({ ...status, loadingMore: true })
    try {
      const page = await fetchAdminAudit({
        action: actionFilter.trim() || undefined,
        actorId: actorFilter.trim() || undefined,
        limit: PAGE_SIZE,
        before: status.nextBefore
      })
      // Recompute against the latest status snapshot — filters may have
      // changed while the page was in flight, in which case we drop the
      // result rather than splicing pages from different filter sets.
      setStatus((cur) => {
        if (cur.kind !== 'ready') return cur
        return {
          kind: 'ready',
          entries: [...cur.entries, ...page.entries],
          nextBefore: page.nextBefore,
          loadingMore: false
        }
      })
    } catch (err) {
      setStatus({ kind: 'error', message: explain(err) })
    }
  }

  return (
    <>
      <Group justify="space-between" align="center" mb="md" gap="md" wrap="wrap">
        <Title order={2} fz={20} fw={600}>
          Admin · Audit log
        </Title>
        <Group gap="xs">
          <TextInput
            size="xs"
            placeholder="Action prefix (e.g. doc., user., upstream.)"
            value={actionFilter}
            onChange={(e) => setActionFilter(e.currentTarget.value)}
            w={260}
          />
          <TextInput
            size="xs"
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

      {status.kind === 'ready' && status.entries.length === 0 && (
        <Text c="dimmed">
          No audit entries match the current filters.
          {(actionFilter || actorFilter) && ' Clear the filters above to see everything.'}
        </Text>
      )}

      {status.kind === 'ready' && status.entries.length > 0 && (
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
              {status.entries.map((e) => (
                <tr key={e.id} onClick={() => setSelected(e)}>
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
            {status.nextBefore !== null ? (
              <Button
                variant="default"
                size="xs"
                onClick={loadMore}
                loading={status.loadingMore}
              >
                Load more
              </Button>
            ) : (
              <Text fz="xs" c="dimmed">
                End of log ({status.entries.length} entr
                {status.entries.length === 1 ? 'y' : 'ies'}).
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

function EntryDrawer({
  entry,
  onClose
}: {
  entry: AuditLogEntry
  onClose: () => void
}) {
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
            {entry.actorEmail ?? <Text component="span" c="dimmed">unknown email</Text>}
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
            <Text fz="xs" c="dimmed">No target.</Text>
          )}
        </Section>
        <Section title="Meta">
          {metaJson ? (
            <Code block style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>
              {metaJson}
            </Code>
          ) : (
            <Text fz="xs" c="dimmed">No metadata.</Text>
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
    <Badge color={color} variant="light" size="sm" style={{ fontFamily: 'var(--mantine-font-family-monospace, monospace)' }}>
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
  const preview = entries.slice(0, 3).map(([k, v]) => `${k}=${formatScalar(v)}`).join(' · ')
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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div
        style={{
          fontSize: 10,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: 'var(--text-dim)',
          marginBottom: 6
        }}
      >
        {title}
      </div>
      {children}
    </div>
  )
}

function absDateTime(ts: number): string {
  return new Date(ts * 1000).toLocaleString()
}

function relativeTime(ts: number): string {
  const now = Math.floor(Date.now() / 1000)
  const delta = now - ts
  if (delta < 60) return `${delta}s ago`
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`
  if (delta < 86400 * 30) return `${Math.floor(delta / 86400)}d ago`
  return new Date(ts * 1000).toLocaleDateString()
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
