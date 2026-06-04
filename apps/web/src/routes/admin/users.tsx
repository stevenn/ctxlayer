import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  Drawer,
  Group,
  MultiSelect,
  Stack,
  Switch,
  Text,
  TextInput,
  Title
} from '@mantine/core'
import type { AdminUserRow, AdminUserTeam, Role, RoleRef } from '@ctxlayer/shared'
import {
  type ApiError,
  adminPatchUserRole,
  adminRevokeUserCredentials,
  fetchAdminUsers,
  fetchRoles,
  putUserRoles
} from '../../lib/api'
import { explain as explainBase } from '../../lib/explain'
import { useDialogs } from '../../lib/dialogs'

export function AdminUsers() {
  const [items, setItems] = useState<AdminUserRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  const reload = useCallback(async (signal?: AbortSignal) => {
    try {
      const list = await fetchAdminUsers(signal)
      if (!signal?.aborted) setItems(list)
    } catch (err) {
      if (!signal?.aborted) setError(explain(err))
    }
  }, [])

  useEffect(() => {
    const ctrl = new AbortController()
    reload(ctrl.signal)
    return () => ctrl.abort()
  }, [reload])

  const filtered = useMemo(() => {
    if (!items) return null
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter(
      (u) => u.email.toLowerCase().includes(q) || (u.name ?? '').toLowerCase().includes(q)
    )
  }, [items, query])

  const editing = items?.find((u) => u.id === editingId) ?? null

  return (
    <>
      <Group justify="space-between" align="center" mb="md">
        <Title order={2} fz={20} fw={600}>
          Admin · Users
        </Title>
        <TextInput
          size="xs"
          placeholder="Filter by email or name…"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          w={260}
        />
      </Group>

      {error && (
        <Alert color="red" variant="light" radius="sm" mb="md">
          {error}
        </Alert>
      )}
      {!items && !error && <Text c="dimmed">Loading…</Text>}

      {items && items.length === 0 && (
        <Text c="dimmed">No users yet — sign in once to create the first row.</Text>
      )}

      {filtered && filtered.length === 0 && items && items.length > 0 && (
        <Text c="dimmed">No users match "{query}".</Text>
      )}

      {filtered && filtered.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Email</th>
              <th>Name</th>
              <th>IdP</th>
              <th>Role</th>
              <th>Teams</th>
              <th>Roles</th>
              <th>Creds</th>
              <th>Last seen</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((u) => (
              <tr key={u.id} onClick={() => setEditingId(u.id)}>
                <td style={{ fontWeight: 500 }}>{u.email}</td>
                <td className="text-muted">{u.name ?? '—'}</td>
                <td className="text-muted">{u.idp}</td>
                <td>
                  <Badge
                    color={u.role === 'admin' ? 'violet' : 'gray'}
                    variant={u.role === 'admin' ? 'filled' : 'light'}
                  >
                    {u.role}
                  </Badge>
                </td>
                <td className="text-muted">
                  {u.teams.length === 0 ? '—' : u.teams.map((t) => t.slug).join(', ')}
                </td>
                <td className="text-muted">
                  {u.roles.length === 0 ? '—' : u.roles.map((r) => r.displayName).join(', ')}
                </td>
                <td className="text-muted">{u.credentialCount}</td>
                <td className="text-muted">{relativeTime(u.lastSeenAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editing && (
        <UserDrawer user={editing} onClose={() => setEditingId(null)} onChanged={() => reload()} />
      )}
    </>
  )
}

// ----- Edit drawer -------------------------------------------------------

function UserDrawer({
  user,
  onClose,
  onChanged
}: {
  user: AdminUserRow
  onClose: () => void
  onChanged: () => void
}) {
  const dialogs = useDialogs()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  // Local switch state mirrors server until persisted (optimistic UI
  // would be nice but we want to surface the last-admin guard error).
  const [isAdmin, setIsAdmin] = useState(user.role === 'admin')
  const [allRoles, setAllRoles] = useState<RoleRef[] | null>(null)
  const [roleIds, setRoleIds] = useState<string[]>(user.roles.map((r) => r.id))

  useEffect(() => {
    setIsAdmin(user.role === 'admin')
    setRoleIds(user.roles.map((r) => r.id))
    setError(null)
    setInfo(null)
  }, [user])

  useEffect(() => {
    const ctrl = new AbortController()
    fetchRoles(ctrl.signal).then(
      (r) => {
        if (!ctrl.signal.aborted) setAllRoles(r)
      },
      () => {
        /* roles list is best-effort; the section just shows a loader */
      }
    )
    return () => ctrl.abort()
  }, [])

  async function withBusy(fn: () => Promise<void>, label: string) {
    setBusy(true)
    setError(null)
    setInfo(null)
    try {
      await fn()
    } catch (err) {
      setError(`${label} failed: ${explain(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const toggleRole = (next: boolean) =>
    withBusy(
      async () => {
        const nextRole: Role = next ? 'admin' : 'user'
        try {
          await adminPatchUserRole(user.id, { role: nextRole })
        } catch (err) {
          // Bounce the switch back on failure (e.g. last-admin guard).
          setIsAdmin(user.role === 'admin')
          throw err
        }
        setIsAdmin(next)
        onChanged()
      },
      next ? 'Promote to admin' : 'Demote to user'
    )

  const saveRoles = (next: string[]) =>
    withBusy(async () => {
      const prev = roleIds
      setRoleIds(next)
      try {
        await putUserRoles(user.id, next)
      } catch (err) {
        setRoleIds(prev) // bounce back on failure
        throw err
      }
      onChanged()
    }, 'Update roles')

  const revokeCreds = () =>
    withBusy(async () => {
      const ok = await dialogs.confirm({
        title: 'Revoke credentials?',
        message: `Revoke all upstream credentials for ${user.email}? They'll need to re-connect every upstream on /upstreams after this.`,
        confirmLabel: 'Revoke',
        danger: true
      })
      if (!ok) return
      const { removed } = await adminRevokeUserCredentials(user.id)
      setInfo(
        removed === 0
          ? 'No credentials were stored — nothing to revoke.'
          : `Revoked ${removed} credential${removed === 1 ? '' : 's'}.`
      )
      onChanged()
    }, 'Revoke credentials')

  return (
    <Drawer
      opened
      onClose={onClose}
      title={`User · ${user.email}`}
      position="right"
      size="md"
      padding="md"
    >
      <Stack gap="md">
        {error && (
          <Alert color="red" variant="light" radius="sm">
            {error}
          </Alert>
        )}
        {info && (
          <Alert
            color="green"
            variant="light"
            radius="sm"
            withCloseButton
            onClose={() => setInfo(null)}
          >
            {info}
          </Alert>
        )}

        <Section title="Identity">
          <Stack gap={4}>
            <KV k="Email" v={user.email} />
            <KV k="Name" v={user.name ?? '—'} />
            <KV k="IdP" v={user.idp} />
            <KV k="User id" v={<code style={{ fontSize: 11 }}>{user.id}</code>} />
            <KV k="Created" v={absDateTime(user.createdAt)} />
            <KV k="Last seen" v={user.lastSeenAt ? absDateTime(user.lastSeenAt) : '—'} />
          </Stack>
        </Section>

        <Section title="Role">
          <Switch
            label="Administrator"
            description="Admins can see the /app/admin/* surface, manage users, upstreams, and visibility."
            checked={isAdmin}
            onChange={(e) => toggleRole(e.currentTarget.checked)}
            disabled={busy}
          />
        </Section>

        <Section title="Team membership">
          {user.teams.length === 0 ? (
            <Text fz="xs" c="dimmed">
              Not a member of any team. Add via Admin · Teams → drawer → Members.
            </Text>
          ) : (
            <Stack gap={4}>
              {user.teams.map((t) => (
                <TeamPill key={t.id} team={t} />
              ))}
            </Stack>
          )}
        </Section>

        <Section title="Roles">
          <Stack gap={6}>
            <Text fz="xs" c="dimmed">
              Cross-cutting org roles (engineering, qa, …). Gate upstreams + tools. Manage the set
              on Admin · Roles.
            </Text>
            <MultiSelect
              placeholder={allRoles ? 'Assign roles…' : 'Loading roles…'}
              data={(allRoles ?? []).map((r) => ({ value: r.id, label: r.displayName }))}
              value={roleIds}
              onChange={saveRoles}
              disabled={busy || !allRoles}
              searchable
              clearable
              comboboxProps={{ withinPortal: true }}
            />
            {allRoles && allRoles.length === 0 && (
              <Text fz="xs" c="dimmed">
                No roles defined yet — create some on Admin · Roles.
              </Text>
            )}
          </Stack>
        </Section>

        <Section title="Upstream credentials">
          <Stack gap={6}>
            <Text fz="xs" c="dimmed">
              {user.credentialCount === 0
                ? 'No upstream credentials on file.'
                : `${user.credentialCount} credential${user.credentialCount === 1 ? '' : 's'} stored (paste-bearer + OAuth combined).`}
            </Text>
            <Group justify="flex-end">
              <Button
                size="xs"
                variant="default"
                color="red"
                onClick={revokeCreds}
                disabled={busy || user.credentialCount === 0}
              >
                Revoke all credentials
              </Button>
            </Group>
          </Stack>
        </Section>
      </Stack>
    </Drawer>
  )
}

// ----- helpers -----------------------------------------------------------

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
    <Group gap="xs" wrap="nowrap" align="baseline">
      <Text fz="xs" c="dimmed" w={80}>
        {k}
      </Text>
      <Text fz="sm" style={{ minWidth: 0 }}>
        {v}
      </Text>
    </Group>
  )
}

function TeamPill({ team }: { team: AdminUserTeam }) {
  return (
    <Group
      justify="space-between"
      px="sm"
      py={6}
      style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}
    >
      <div style={{ minWidth: 0 }}>
        <Text fz="sm">{team.displayName}</Text>
        <Text fz="xs" c="dimmed">
          <code>{team.slug}</code>
        </Text>
      </div>
      <Badge color={team.role === 'lead' ? 'blue' : 'gray'} variant="light">
        {team.role}
      </Badge>
    </Group>
  )
}

function absDateTime(ts: number): string {
  return new Date(ts * 1000).toLocaleString()
}

function relativeTime(ts: number | null): string {
  if (!ts) return '—'
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
    404: 'User not found.',
    400: (e) => bodyMessage(e) ?? 'Server rejected the request.'
  })
}

// Preferred body-message order for this screen: hint → message → error.
function bodyMessage(err: ApiError): string | null {
  const body = err.body as { error?: string; hint?: string; message?: string } | null | undefined
  if (!body || typeof body !== 'object') return null
  if (typeof body.hint === 'string' && body.hint) return body.hint
  if (typeof body.message === 'string' && body.message) return body.message
  if (typeof body.error === 'string' && body.error) return body.error
  return null
}
