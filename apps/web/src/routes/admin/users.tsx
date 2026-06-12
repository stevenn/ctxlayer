import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  Drawer,
  Group,
  MultiSelect,
  SegmentedControl,
  Stack,
  Switch,
  Text,
  TextInput,
  Title
} from '@mantine/core'
import type { AdminUserRow, AdminUserTeam, Role, UserStatus } from '@ctxlayer/shared'
import {
  type ApiError,
  adminDeleteUser,
  adminPatchUserRole,
  adminReactivateUser,
  adminRejectUser,
  adminRevokeUserCredentials,
  adminSuspendUser,
  fetchAdminUsers,
  fetchRoles,
  putUserRoles
} from '../../lib/api'
import { KV, Section } from '../../components/admin-bits'
import { explain as explainBase } from '../../lib/explain'
import { absDateTime, relativeTime } from '../../lib/time'
import { useBusyAction } from '../../lib/use-busy'
import { useLoad } from '../../lib/use-load'
import { useDrawerConfirm } from '../../lib/dialogs'

type StatusFilter = 'all' | UserStatus

export function AdminUsers() {
  const { data: items, error, reload } = useLoad(fetchAdminUsers, [], { explain })
  const [editingId, setEditingId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')

  const counts = useMemo(() => {
    const c = { all: items?.length ?? 0, active: 0, pending: 0, suspended: 0 }
    for (const u of items ?? []) c[u.status]++
    return c
  }, [items])

  const filtered = useMemo(() => {
    if (!items) return null
    const q = query.trim().toLowerCase()
    return items.filter((u) => {
      if (statusFilter !== 'all' && u.status !== statusFilter) return false
      if (!q) return true
      return u.email.toLowerCase().includes(q) || (u.name ?? '').toLowerCase().includes(q)
    })
  }, [items, query, statusFilter])

  const editing = items?.find((u) => u.id === editingId) ?? null

  return (
    <>
      <Group justify="space-between" align="center" mb="md">
        <Group gap="sm" align="center">
          <Title order={2} fz={20} fw={600}>
            Admin · Users
          </Title>
          {counts.pending > 0 && (
            <Badge color="yellow" variant="filled" radius="sm">
              {counts.pending} pending
            </Badge>
          )}
        </Group>
        <TextInput
          size="xs"
          placeholder="Filter by email or name…"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          w={260}
        />
      </Group>

      <SegmentedControl
        size="xs"
        mb="md"
        value={statusFilter}
        onChange={(v) => setStatusFilter(v as StatusFilter)}
        data={[
          { value: 'all', label: `All (${counts.all})` },
          { value: 'active', label: `Active (${counts.active})` },
          { value: 'pending', label: `Pending (${counts.pending})` },
          { value: 'suspended', label: `Suspended (${counts.suspended})` }
        ]}
      />

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
        <Text c="dimmed">No users match the current filter.</Text>
      )}

      {filtered && filtered.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Email</th>
              <th>Name</th>
              <th>IdP</th>
              <th>Role</th>
              <th>Status</th>
              <th>Teams</th>
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
                <td>
                  <StatusBadge status={u.status} />
                </td>
                <td className="text-muted">
                  {u.teams.length === 0 ? '—' : u.teams.map((t) => t.slug).join(', ')}
                </td>
                <td className="text-muted">{u.credentialCount}</td>
                <td className="text-muted">{relativeTime(u.lastSeenAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editing && (
        <UserDrawer
          user={editing}
          onClose={() => setEditingId(null)}
          onChanged={() => reload()}
          onRemoved={() => {
            setEditingId(null)
            reload()
          }}
        />
      )}
    </>
  )
}

const STATUS_COLOR: Record<UserStatus, string> = {
  active: 'green',
  pending: 'yellow',
  suspended: 'red'
}

function StatusBadge({ status }: { status: UserStatus }) {
  return (
    <Badge color={STATUS_COLOR[status]} variant={status === 'active' ? 'light' : 'filled'}>
      {status}
    </Badge>
  )
}

// ----- Edit drawer -------------------------------------------------------

function UserDrawer({
  user,
  onClose,
  onChanged,
  onRemoved
}: {
  user: AdminUserRow
  onClose: () => void
  onChanged: () => void
  onRemoved: () => void
}) {
  const { hidden, confirm } = useDrawerConfirm()
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  // Local switch state mirrors server until persisted (optimistic UI
  // would be nice but we want to surface the last-admin guard error).
  const [isAdmin, setIsAdmin] = useState(user.role === 'admin')
  // Roles list is best-effort; the section just shows a loader on failure.
  const { data: allRoles } = useLoad(fetchRoles, [], { onError: () => {} })
  const [roleIds, setRoleIds] = useState<string[]>(user.roles.map((r) => r.id))

  useEffect(() => {
    setIsAdmin(user.role === 'admin')
    setRoleIds(user.roles.map((r) => r.id))
    setError(null)
    setInfo(null)
  }, [user])

  const { busy, run: withBusy } = useBusyAction({
    explain,
    setError,
    onStart: () => setInfo(null)
  })

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
      const ok = await confirm({
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

  // ----- lifecycle -----
  const reactivate = (label: string) =>
    withBusy(async () => {
      await adminReactivateUser(user.id)
      onChanged()
    }, label)

  const suspend = () =>
    withBusy(async () => {
      const ok = await confirm({
        title: 'Suspend user?',
        message: `Suspend ${user.email}? They're signed out immediately and any live MCP/agent tokens are revoked — they can't sign in or use the MCP server until reactivated (which requires reconnecting their MCP client). Reversible; audit history is kept.`,
        confirmLabel: 'Suspend',
        danger: true
      })
      if (!ok) return
      const { revokedGrants, complete } = await adminSuspendUser(user.id)
      setInfo(
        complete === false
          ? `Suspended, but token revocation was incomplete (revoked ${revokedGrants}) — an open MCP session may survive. Retry the suspend to finish.`
          : revokedGrants > 0
            ? `Suspended. Revoked ${revokedGrants} active token${revokedGrants === 1 ? '' : 's'} — their MCP/agent sessions are cut.`
            : 'Suspended. No active MCP tokens to revoke.'
      )
      onChanged()
    }, 'Suspend')

  const reject = () =>
    withBusy(async () => {
      const ok = await confirm({
        title: 'Reject request?',
        message: `Reject ${user.email}'s pending access request? Their record is removed. They can request again later.`,
        confirmLabel: 'Reject',
        danger: true
      })
      if (!ok) return
      await adminRejectUser(user.id)
      onRemoved()
    }, 'Reject')

  const remove = () =>
    withBusy(async () => {
      const ok = await confirm({
        title: 'Delete user?',
        message: `Permanently delete ${user.email}? Removes team/role memberships and stored credentials, de-attributes authored docs, and reassigns any skills they own to you. If they're still on the IdP allowlist they'll re-appear on next sign-in.`,
        confirmLabel: 'Delete',
        danger: true
      })
      if (!ok) return
      await adminDeleteUser(user.id)
      onRemoved()
    }, 'Delete')

  return (
    <Drawer
      opened={!hidden}
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

        <Section title="Lifecycle">
          <Stack gap={8}>
            <Group gap="xs" align="center">
              <Text fz="xs" c="dimmed">
                Status
              </Text>
              <StatusBadge status={user.status} />
            </Group>
            {user.status === 'pending' ? (
              <>
                <Text fz="xs" c="dimmed">
                  Awaiting approval. Approving grants access; rejecting removes the request.
                </Text>
                <Group justify="flex-end" gap="xs">
                  <Button size="xs" variant="default" color="red" onClick={reject} disabled={busy}>
                    Reject
                  </Button>
                  <Button size="xs" onClick={() => reactivate('Approve')} disabled={busy}>
                    Approve
                  </Button>
                </Group>
              </>
            ) : (
              <Group justify="flex-end" gap="xs">
                {user.status === 'suspended' ? (
                  <Button size="xs" onClick={() => reactivate('Reactivate')} disabled={busy}>
                    Reactivate
                  </Button>
                ) : (
                  <Button size="xs" variant="default" color="orange" onClick={suspend} disabled={busy}>
                    Suspend
                  </Button>
                )}
                <Button size="xs" variant="default" color="red" onClick={remove} disabled={busy}>
                  Delete…
                </Button>
              </Group>
            )}
          </Stack>
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
