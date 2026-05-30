import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  Code,
  Drawer,
  Group,
  Stack,
  Switch,
  Text,
  TextInput,
  Title,
  Tooltip
} from '@mantine/core'
import type { OAuthClientRow, OAuthClientUserRef } from '@ctxlayer/shared'
import {
  ApiError,
  ApiSchemaError,
  fetchAdminOAuthClients,
  pruneAdminOAuthClients
} from '../../lib/api'
import { useDialogs } from '../../lib/dialogs'

/**
 * Admin · OAuth clients (M5 phase 4).
 *
 * Read-only view of every client registered against the MCP server.
 * Clients land here automatically when an MCP host does Dynamic Client
 * Registration (Claude Web's Connectors, Cursor, etc.). The shape is
 * defined by RFC 7591; we render the human-meaningful fields and stash
 * the raw record in a drawer.
 *
 * Filter is client-side over the loaded set — the dataset is small
 * (one row per (host, install) pair) so we don't push it down to KV.
 *
 * "Orphans" are public clients with zero grants — abandoned loopback
 * DCR registrations (Claude Code/Cursor/Windsurf mint a fresh client
 * per auth attempt; retried/cancelled ones never get a grant). They're
 * hidden by default and auto-pruned server-side once >1 day old. The
 * orphan predicate here mirrors the server prune (`isPrunableClient`):
 * confidential zero-grant clients are NOT orphans (they may just be
 * unused), so they stay visible and are never auto-pruned.
 */

type Status =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | {
      kind: 'ready'
      clients: OAuthClientRow[]
      nextCursor: string | null
      loadingMore: boolean
    }

const PAGE_SIZE = 100

export function AdminOAuthClients() {
  const [status, setStatus] = useState<Status>({ kind: 'loading' })
  const [query, setQuery] = useState('')
  const [hideOrphans, setHideOrphans] = useState(true)
  const [pruning, setPruning] = useState(false)
  const [selected, setSelected] = useState<OAuthClientRow | null>(null)
  const ctrlRef = useRef<AbortController | null>(null)
  const dialogs = useDialogs()

  const load = useCallback(async () => {
    ctrlRef.current?.abort()
    const ctrl = new AbortController()
    ctrlRef.current = ctrl
    setStatus({ kind: 'loading' })
    try {
      const page = await fetchAdminOAuthClients({ limit: PAGE_SIZE }, ctrl.signal)
      if (ctrl.signal.aborted) return
      setStatus({
        kind: 'ready',
        clients: page.clients,
        nextCursor: page.nextCursor,
        loadingMore: false
      })
    } catch (err) {
      if (ctrl.signal.aborted) return
      setStatus({ kind: 'error', message: explain(err) })
    }
  }, [])

  useEffect(() => {
    load()
    return () => ctrlRef.current?.abort()
  }, [load])

  async function loadMore() {
    if (status.kind !== 'ready' || !status.nextCursor || status.loadingMore) return
    setStatus({ ...status, loadingMore: true })
    try {
      const page = await fetchAdminOAuthClients({
        cursor: status.nextCursor,
        limit: PAGE_SIZE
      })
      setStatus((cur) => {
        if (cur.kind !== 'ready') return cur
        return {
          kind: 'ready',
          clients: [...cur.clients, ...page.clients],
          nextCursor: page.nextCursor,
          loadingMore: false
        }
      })
    } catch (err) {
      setStatus({ kind: 'error', message: explain(err) })
    }
  }

  const orphanCount = useMemo(() => {
    if (status.kind !== 'ready') return 0
    return status.clients.filter(isOrphanClient).length
  }, [status])

  async function runPrune() {
    const ok = await dialogs.confirm({
      title: 'Prune orphan clients',
      message:
        'Delete every public client registration that has no grants and is ' +
        'older than 1 day? These are abandoned loopback-OAuth registrations; ' +
        'a host that needs one again re-registers automatically. Confidential ' +
        'clients are never touched.',
      confirmLabel: 'Prune',
      danger: true
    })
    if (!ok) return
    setPruning(true)
    try {
      const r = await pruneAdminOAuthClients()
      if (r.skippedIncompleteIndex) {
        await dialogs.alert({
          title: 'Prune skipped',
          message:
            'The grant index could not be read in full, so nothing was ' +
            'deleted (fail-safe — a real client could have looked orphaned). ' +
            'Try again in a moment.'
        })
      } else {
        await dialogs.alert({
          title: 'Prune complete',
          message: `Removed ${r.deleted} of ${r.orphans} orphan client${
            r.orphans === 1 ? '' : 's'
          } (scanned ${r.scanned}${r.failed ? `, ${r.failed} delete failures` : ''}).`
        })
        await load()
      }
    } catch (err) {
      await dialogs.alert({ title: 'Prune failed', message: explain(err) })
    } finally {
      setPruning(false)
    }
  }

  const filtered = useMemo(() => {
    if (status.kind !== 'ready') return null
    const q = query.trim().toLowerCase()
    return status.clients.filter((c) => {
      if (hideOrphans && isOrphanClient(c)) return false
      if (!q) return true
      if (c.clientId.toLowerCase().includes(q)) return true
      if ((c.clientName ?? '').toLowerCase().includes(q)) return true
      if (c.redirectUris.some((u) => u.toLowerCase().includes(q))) return true
      return false
    })
  }, [status, query, hideOrphans])

  return (
    <>
      <Group justify="space-between" align="center" mb="md" gap="md" wrap="nowrap">
        <Title order={2} fz={20} fw={600}>
          Admin · OAuth clients
        </Title>
        <Group gap="md" wrap="nowrap">
          <Button
            size="xs"
            variant="default"
            onClick={runPrune}
            loading={pruning}
            disabled={status.kind !== 'ready' || orphanCount === 0}
          >
            Prune orphans
          </Button>
          <Tooltip
            label="Public clients with no grants — abandoned loopback registrations. Auto-pruned once older than 1 day."
            multiline
            maw={260}
            withArrow
          >
            <Switch
              size="xs"
              checked={hideOrphans}
              onChange={(e) => setHideOrphans(e.currentTarget.checked)}
              disabled={status.kind !== 'ready'}
              label={`Hide orphans${orphanCount ? ` (${orphanCount})` : ''}`}
            />
          </Tooltip>
          <TextInput
            size="xs"
            placeholder="Filter by name, id, or redirect URI…"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            w={300}
            disabled={status.kind !== 'ready'}
          />
        </Group>
      </Group>

      <Text c="dimmed" fz="sm" mb="md">
        Clients registered against this MCP server (mostly via Dynamic Client
        Registration when a host first connects). Read-only — registrations
        come in over <code>/oauth/register</code>.
      </Text>

      {status.kind === 'error' && (
        <Alert color="red" variant="light" radius="sm">
          {status.message}
        </Alert>
      )}

      {status.kind === 'loading' && <Text c="dimmed">Loading…</Text>}

      {status.kind === 'ready' && status.clients.length === 0 && (
        <Text c="dimmed">
          No clients have registered yet. Connect Claude or another MCP host
          via <code>/app/mcp-setup</code> and one will appear here.
        </Text>
      )}

      {filtered && filtered.length === 0 && status.kind === 'ready' && status.clients.length > 0 && (
        <Text c="dimmed">
          {query.trim()
            ? `No clients match "${query}".`
            : `All ${status.clients.length} loaded client${
                status.clients.length === 1 ? ' is an orphan' : 's are orphans'
              } (hidden). Toggle "Hide orphans" to show them.`}
        </Text>
      )}

      {filtered && filtered.length > 0 && (
        <>
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Client id</th>
                <th>Users</th>
                <th>Redirects</th>
                <th style={{ textAlign: 'right' }}>Registered</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr key={c.clientId} onClick={() => setSelected(c)}>
                  <td style={{ fontWeight: 500 }}>{c.clientName ?? <span style={{ color: 'var(--text-dim)' }}>(unnamed)</span>}</td>
                  <td>
                    <ClientTypeBadge method={c.tokenEndpointAuthMethod} />
                  </td>
                  <td className="text-muted">
                    <code style={{ fontSize: 11 }}>{truncateMiddle(c.clientId, 22)}</code>
                  </td>
                  <td className="text-muted">
                    {isOrphanClient(c) ? <OrphanBadge /> : <UsersCell users={c.users} />}
                  </td>
                  <td className="text-muted">
                    <RedirectCell uris={c.redirectUris} />
                  </td>
                  <td className="text-muted" style={{ textAlign: 'right' }}>
                    {c.registrationDate ? relativeTime(c.registrationDate) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {status.kind === 'ready' && (
            <Group justify="center" mt="md">
              {status.nextCursor ? (
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
                  End of list ({status.clients.length} client
                  {status.clients.length === 1 ? '' : 's'}).
                </Text>
              )}
            </Group>
          )}
        </>
      )}

      {selected && <ClientDrawer client={selected} onClose={() => setSelected(null)} />}
    </>
  )
}

// ----- Drawer ------------------------------------------------------------

function ClientDrawer({
  client,
  onClose
}: {
  client: OAuthClientRow
  onClose: () => void
}) {
  const raw = JSON.stringify(client, null, 2)
  return (
    <Drawer
      opened
      onClose={onClose}
      title={`OAuth client · ${client.clientName ?? client.clientId}`}
      position="right"
      size="md"
      padding="md"
    >
      <Stack gap="md">
        <Section title="Identity">
          <KV k="Name" v={client.clientName ?? '—'} />
          <KV k="Id" v={<code style={{ fontSize: 11 }}>{client.clientId}</code>} />
          <KV
            k="Type"
            v={
              <Group gap="xs">
                <ClientTypeBadge method={client.tokenEndpointAuthMethod} />
                {isOrphanClient(client) && <OrphanBadge />}
              </Group>
            }
          />
          <KV
            k="Auth method"
            v={<code style={{ fontSize: 11 }}>{client.tokenEndpointAuthMethod}</code>}
          />
          <KV
            k="Registered"
            v={client.registrationDate ? absDateTime(client.registrationDate) : '—'}
          />
        </Section>

        <Section title="Redirect URIs">
          {client.redirectUris.length === 0 ? (
            <Text fz="xs" c="dimmed">No redirect URIs registered.</Text>
          ) : (
            <Stack gap={2}>
              {client.redirectUris.map((u) => (
                <code key={u} style={{ fontSize: 11, wordBreak: 'break-all' }}>
                  {u}
                </code>
              ))}
            </Stack>
          )}
        </Section>

        <Section title="OAuth metadata">
          <KV k="Grants" v={listOrDash(client.grantTypes)} />
          <KV k="Response types" v={listOrDash(client.responseTypes)} />
          <KV k="Homepage" v={linkOrDash(client.clientUri)} />
          <KV k="Logo" v={linkOrDash(client.logoUri)} />
          <KV k="Privacy" v={linkOrDash(client.policyUri)} />
          <KV k="Terms" v={linkOrDash(client.tosUri)} />
          <KV k="Contacts" v={listOrDash(client.contacts)} />
        </Section>

        <Section title="Authorised users">
          {client.users.length === 0 ? (
            <Text fz="xs" c="dimmed">
              No ctxlayer user has authorised this client yet.
            </Text>
          ) : (
            <Stack gap={4}>
              {client.users.map((u) => (
                <Group key={u.userId} gap="xs" wrap="nowrap" align="baseline">
                  <Text fz="sm" style={{ minWidth: 0 }}>
                    {u.name ? `${u.name} ` : ''}
                    <Text component="span" c="dimmed" fz="xs">
                      &lt;{u.email}&gt;
                    </Text>
                  </Text>
                  <Text fz="xs" c="dimmed">
                    granted {relativeTime(u.grantedAt)}
                  </Text>
                </Group>
              ))}
            </Stack>
          )}
        </Section>

        <Section title="Raw record">
          <Code block style={{ fontSize: 11, whiteSpace: 'pre-wrap' }}>
            {raw}
          </Code>
        </Section>
      </Stack>
    </Drawer>
  )
}

// ----- bits --------------------------------------------------------------

/**
 * Orphan = public client with zero grants. Mirrors the server prune
 * predicate (`oauth/prune-clients.ts#isPrunableClient`), minus the age
 * check — the UI flags them as soon as they're grant-less; the server
 * only deletes them once >1 day old.
 */
function isOrphanClient(c: OAuthClientRow): boolean {
  return c.tokenEndpointAuthMethod === 'none' && c.users.length === 0
}

function OrphanBadge() {
  return (
    <Tooltip
      label="Public client, no grants. Auto-pruned once older than 1 day."
      withArrow
    >
      <Badge size="sm" color="gray" variant="outline">
        orphan
      </Badge>
    </Tooltip>
  )
}

function ClientTypeBadge({ method }: { method: string }) {
  const isPublic = method === 'none'
  return (
    <Badge size="sm" color={isPublic ? 'cyan' : 'violet'} variant="light">
      {isPublic ? 'public' : 'confidential'}
    </Badge>
  )
}

function UsersCell({ users }: { users: OAuthClientUserRef[] }) {
  if (users.length === 0) {
    return (
      <Text component="span" fz="xs" c="dimmed">
        none
      </Text>
    )
  }
  const first = users[0]!
  const label = first.name || first.email
  if (users.length === 1) {
    return (
      <Tooltip label={`Granted ${absDateTime(first.grantedAt)}`} withArrow>
        <span>{label}</span>
      </Tooltip>
    )
  }
  const rest = users
    .slice(1)
    .map((u) => `• ${u.name || u.email} (granted ${relativeTime(u.grantedAt)})`)
    .join('\n')
  return (
    <Tooltip multiline maw={320} label={`Also:\n${rest}`} withArrow>
      <span>
        {label}
        <Text component="span" fz="xs" c="dimmed" ml={6}>
          +{users.length - 1}
        </Text>
      </span>
    </Tooltip>
  )
}

function RedirectCell({ uris }: { uris: string[] }) {
  if (uris.length === 0) return <span>—</span>
  const first = uris[0]!
  if (uris.length === 1) {
    return <code style={{ fontSize: 11 }}>{truncateUri(first)}</code>
  }
  return (
    <Tooltip
      multiline
      maw={420}
      label={uris.map((u) => `• ${u}`).join('\n')}
      withArrow
    >
      <span>
        <code style={{ fontSize: 11 }}>{truncateUri(first)}</code>
        <Text component="span" fz="xs" c="dimmed" ml={6}>
          +{uris.length - 1}
        </Text>
      </span>
    </Tooltip>
  )
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

function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <Group gap="xs" wrap="nowrap" align="baseline" mb={4}>
      <Text fz="xs" c="dimmed" w={110}>
        {k}
      </Text>
      <Text fz="sm" style={{ minWidth: 0 }}>
        {v}
      </Text>
    </Group>
  )
}

function listOrDash(items: string[] | null): React.ReactNode {
  if (!items || items.length === 0) return '—'
  return items.join(', ')
}

function linkOrDash(href: string | null): React.ReactNode {
  if (!href) return '—'
  return (
    <a href={href} target="_blank" rel="noreferrer" style={{ wordBreak: 'break-all' }}>
      {href}
    </a>
  )
}

function truncateUri(u: string): string {
  if (u.length <= 60) return u
  return u.slice(0, 40) + '…' + u.slice(-15)
}

function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s
  const keep = Math.floor((max - 1) / 2)
  return s.slice(0, keep) + '…' + s.slice(-keep)
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
  if (err instanceof ApiError && err.status === 401)
    return 'Your session expired. Refresh to sign in again.'
  if (err instanceof ApiError && err.status === 403) return 'Admin permission required.'
  if (err instanceof ApiError) return `Server returned HTTP ${err.status}.`
  if (err instanceof ApiSchemaError) return 'Server returned an unexpected response shape.'
  if (err instanceof Error) return err.message
  return 'Could not reach the server.'
}
