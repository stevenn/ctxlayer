import { useCallback, useEffect, useRef, useState } from 'react'
import { useSlugSuggest } from '../../lib/use-slug-suggest'
import {
  Alert,
  Button,
  Checkbox,
  Drawer,
  Group,
  Modal,
  Select,
  Stack,
  Text,
  TextInput,
  Title
} from '@mantine/core'
import type {
  AdminTeamRow,
  ProductRef,
  TeamMemberRole,
  TeamMemberRow,
  TeamProductsAssignment,
  UserSearchResult
} from '@ctxlayer/shared'
import {
  addTeamMember,
  adminCreateTeam,
  adminDeleteTeam,
  adminPatchTeam,
  fetchAdminTeams,
  fetchProducts,
  fetchTeamMembers,
  fetchTeamProducts,
  putTeamProducts,
  removeTeamMember,
  searchUsers
} from '../../lib/api'
import { Section } from '../../components/admin-bits'
import { clickableRow } from '../../lib/a11y'
import { explain as explainBase } from '../../lib/explain'
import { useBusyAction } from '../../lib/use-busy'
import { useLoad } from '../../lib/use-load'
import { useDrawerConfirm } from '../../lib/dialogs'

export function AdminTeams() {
  const { data: teams, error, reload } = useLoad(fetchAdminTeams, [], { explain })
  const [createOpen, setCreateOpen] = useState(false)
  const [editingTeam, setEditingTeam] = useState<AdminTeamRow | null>(null)

  return (
    <>
      <Group justify="space-between" align="center" mb="md">
        <Title order={2} fz={20} fw={600}>
          Admin · Teams
        </Title>
        <Button onClick={() => setCreateOpen(true)}>+ New team</Button>
      </Group>

      {error && (
        <Alert color="red" variant="light" radius="sm" mb="md">
          {error}
        </Alert>
      )}
      {!teams && !error && <Text c="dimmed">Loading…</Text>}

      {teams && teams.length === 0 && (
        <Text c="dimmed">
          No teams yet. Click <strong>+ New team</strong> to create the first one.
        </Text>
      )}

      {teams && teams.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Display name</th>
              <th>Slug</th>
              <th>Description</th>
              <th>IdP group</th>
              <th>Managed by IdP</th>
            </tr>
          </thead>
          <tbody>
            {teams.map((t) => (
              <tr key={t.id} {...clickableRow(() => setEditingTeam(t))}>
                <td style={{ fontWeight: 500 }}>{t.displayName}</td>
                <td className="text-muted">
                  <code>{t.slug}</code>
                </td>
                <td className="text-muted">{t.description ?? '—'}</td>
                <td className="text-muted">
                  {t.idpGroup ? <code style={{ fontSize: 11 }}>{t.idpGroup}</code> : '—'}
                </td>
                <td className="text-muted">{t.managedByIdp ? 'Yes' : 'No'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {createOpen && (
        <CreateTeamModal
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false)
            reload()
          }}
        />
      )}

      {editingTeam && (
        <TeamDrawer
          team={editingTeam}
          onClose={() => setEditingTeam(null)}
          onChanged={() => reload()}
          onDeleted={() => {
            setEditingTeam(null)
            reload()
          }}
        />
      )}
    </>
  )
}

// ----- Create modal ------------------------------------------------------

// Conditionally mounted by the caller (`{createOpen && <CreateTeamModal/>}`),
// so all state resets for free on close — no `opened` prop / reset effect.
function CreateTeamModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [displayName, setDisplayName] = useState('')
  const slugField = useSlugSuggest('team', displayName)
  const [description, setDescription] = useState('')
  const [idpGroup, setIdpGroup] = useState('')
  const [managedByIdp, setManagedByIdp] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    if (!slugField.slug.trim() || !displayName.trim()) return
    setBusy(true)
    setError(null)
    try {
      await adminCreateTeam({
        slug: slugField.slug.trim(),
        displayName: displayName.trim(),
        description: description.trim() || null,
        idpGroup: idpGroup.trim() || null,
        managedByIdp
      })
      onCreated()
    } catch (err) {
      setError(explain(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal opened onClose={onClose} title="New team" centered>
      <Stack gap="md">
        <TextInput
          label="Display name"
          placeholder="Platform"
          value={displayName}
          onChange={(e) => setDisplayName(e.currentTarget.value)}
        />
        <TextInput
          label="Slug"
          placeholder="team-platform"
          value={slugField.slug}
          onChange={(e) => slugField.setSlug(e.currentTarget.value)}
          description="Auto-filled from the name; edit to customise. Must start with team-."
        />
        <TextInput
          label="Description"
          placeholder="Optional"
          value={description}
          onChange={(e) => setDescription(e.currentTarget.value)}
        />
        <TextInput
          label="IdP group"
          placeholder="google:eng@example.com or github:acme/platform"
          value={idpGroup}
          onChange={(e) => setIdpGroup(e.currentTarget.value)}
          description="Optional. Reserved for future SSO/group-sync — no automatic membership today."
        />
        <Checkbox
          label="Managed by IdP"
          description="Flag intent — sync logic not implemented yet."
          checked={managedByIdp}
          onChange={(e) => setManagedByIdp(e.currentTarget.checked)}
        />
        {error && (
          <Alert color="red" variant="light" radius="sm">
            {error}
          </Alert>
        )}
        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            loading={busy}
            disabled={!slugField.slug.trim() || !displayName.trim()}
          >
            Create
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}

// ----- Edit drawer (form + members + team↔product) ------------------------

function TeamDrawer({
  team,
  onClose,
  onChanged,
  onDeleted
}: {
  team: AdminTeamRow
  onClose: () => void
  onChanged: () => void
  onDeleted: () => void
}) {
  const { hidden, confirm, reveal } = useDrawerConfirm()
  const [slug, setSlug] = useState(team.slug)
  const [displayName, setDisplayName] = useState(team.displayName)
  const [description, setDescription] = useState(team.description ?? '')
  const [idpGroup, setIdpGroup] = useState(team.idpGroup ?? '')
  const [managedByIdp, setManagedByIdp] = useState(team.managedByIdp)
  const [members, setMembers] = useState<TeamMemberRow[] | null>(null)
  const [products, setProducts] = useState<ProductRef[] | null>(null)
  const [allTeamProducts, setAllTeamProducts] = useState<TeamProductsAssignment[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Member-search state
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<UserSearchResult>([])
  const debouncer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const reloadMembers = useCallback(async () => {
    setMembers(await fetchTeamMembers(team.id))
  }, [team.id])

  useEffect(() => {
    const ctrl = new AbortController()
    Promise.all([
      fetchTeamMembers(team.id, ctrl.signal),
      fetchProducts(ctrl.signal),
      fetchTeamProducts(ctrl.signal)
    ]).then(
      ([m, p, tp]) => {
        if (ctrl.signal.aborted) return
        setMembers(m)
        setProducts(p)
        setAllTeamProducts(tp)
      },
      (err) => {
        if (!ctrl.signal.aborted) setError(explain(err))
      }
    )
    return () => ctrl.abort()
  }, [team.id])

  // Member-search debounce
  useEffect(() => {
    if (debouncer.current) clearTimeout(debouncer.current)
    debouncer.current = setTimeout(async () => {
      if (query.trim().length < 2) {
        setResults([])
        return
      }
      try {
        setResults(await searchUsers(query.trim()))
      } catch {
        setResults([])
      }
    }, 180)
    return () => {
      if (debouncer.current) clearTimeout(debouncer.current)
    }
  }, [query])

  const { busy, run: withBusy } = useBusyAction({
    explain,
    setError,
    // a delete that hid the drawer then failed must show the error
    onError: reveal
  })

  const savePatch = () =>
    withBusy(async () => {
      const trimmedSlug = slug.trim()
      await adminPatchTeam(team.id, {
        // Only send slug when it actually changed: a grandfathered (pre-
        // prefix) team can be edited without being forced to re-slug, and
        // the `team-` prefix is enforced only on a real rename.
        ...(trimmedSlug !== team.slug ? { slug: trimmedSlug } : {}),
        displayName: displayName.trim(),
        description: description.trim() || null,
        idpGroup: idpGroup.trim() || null,
        managedByIdp
      })
      onChanged()
    }, 'Save')

  const onDelete = () =>
    withBusy(async () => {
      const ok = await confirm(
        {
          title: 'Delete team?',
          message: `Delete team "${team.displayName}"? Members and product links are removed.`,
          confirmLabel: 'Delete',
          danger: true
        },
        { keepHiddenOnConfirm: true }
      )
      if (!ok) return
      await adminDeleteTeam(team.id)
      onDeleted()
    }, 'Delete')

  const addMember = (userId: string, role: TeamMemberRole) =>
    withBusy(async () => {
      await addTeamMember(team.id, { userId, role })
      setQuery('')
      setResults([])
      await reloadMembers()
    }, 'Add member')

  const removeMember = (userId: string) =>
    withBusy(async () => {
      await removeTeamMember(team.id, userId)
      await reloadMembers()
    }, 'Remove member')

  // Toggle a single team↔product link by recomputing the full matrix
  // (the PUT replaces the entire set). Cheap for v1.
  const toggleProduct = (productId: string, on: boolean) =>
    withBusy(async () => {
      if (!allTeamProducts) return
      const current = new Set(
        allTeamProducts.filter((r) => r.teamId === team.id).map((r) => r.productId)
      )
      if (on) current.add(productId)
      else current.delete(productId)
      // Reconstruct the full matrix: other teams' rows + this team's new set.
      const other = allTeamProducts.filter((r) => r.teamId !== team.id)
      const next = [
        ...other,
        ...Array.from(current).map((pid) => ({ teamId: team.id, productId: pid }))
      ]
      await putTeamProducts(next)
      setAllTeamProducts(next)
    }, 'Update products')

  const myProductIds = new Set(
    (allTeamProducts ?? []).filter((r) => r.teamId === team.id).map((r) => r.productId)
  )

  return (
    <Drawer
      opened={!hidden}
      onClose={onClose}
      title={`Team · ${team.displayName}`}
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

        <Stack gap="xs">
          <TextInput
            label="Display name"
            value={displayName}
            onChange={(e) => setDisplayName(e.currentTarget.value)}
          />
          <TextInput label="Slug" value={slug} onChange={(e) => setSlug(e.currentTarget.value)} />
          <TextInput
            label="Description"
            value={description}
            onChange={(e) => setDescription(e.currentTarget.value)}
          />
          <TextInput
            label="IdP group"
            placeholder="google:eng@example.com or github:acme/platform"
            value={idpGroup}
            onChange={(e) => setIdpGroup(e.currentTarget.value)}
            description="Optional. Reserved for future SSO/group-sync — no automatic membership today."
          />
          <Checkbox
            label="Managed by IdP"
            description="Flag intent — sync logic not implemented yet."
            checked={managedByIdp}
            onChange={(e) => setManagedByIdp(e.currentTarget.checked)}
          />
          <Group justify="flex-end" gap="xs">
            <Button variant="default" color="red" onClick={onDelete} disabled={busy}>
              Delete
            </Button>
            <Button onClick={savePatch} loading={busy}>
              Save
            </Button>
          </Group>
        </Stack>

        <Section title="Members">
          <Stack gap={6}>
            <TextInput
              size="xs"
              aria-label="Add member by email"
              placeholder="Add by email…"
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
            />
            {results.length > 0 && (
              <Stack gap={4}>
                {results.map((u) => (
                  <AddCandidateRow
                    key={u.id}
                    user={u}
                    onAdd={(role) => addMember(u.id, role)}
                    disabled={busy}
                  />
                ))}
              </Stack>
            )}
            {!members && (
              <Text c="dimmed" fz="xs">
                Loading…
              </Text>
            )}
            {members && members.length === 0 && (
              <Text c="dimmed" fz="xs">
                No members yet.
              </Text>
            )}
            {members && members.length > 0 && (
              <Stack gap={4}>
                {members.map((m) => (
                  <Group
                    key={m.userId}
                    justify="space-between"
                    px="sm"
                    py={6}
                    style={{
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius-sm)'
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13 }}>{m.email}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                        {m.name ? `${m.name} · ` : ''}
                        {m.role}
                      </div>
                    </div>
                    <Button
                      size="xs"
                      variant="subtle"
                      color="red"
                      onClick={() => removeMember(m.userId)}
                      disabled={busy}
                    >
                      Remove
                    </Button>
                  </Group>
                ))}
              </Stack>
            )}
          </Stack>
        </Section>

        <Section title="Linked products">
          {!products && (
            <Text c="dimmed" fz="xs">
              Loading…
            </Text>
          )}
          {products && products.length === 0 && (
            <Text c="dimmed" fz="xs">
              No products yet. Create one on the Products page.
            </Text>
          )}
          {products && products.length > 0 && (
            <Stack gap={4}>
              {products.map((p) => (
                <Checkbox
                  key={p.id}
                  label={p.displayName}
                  checked={myProductIds.has(p.id)}
                  onChange={(e) => toggleProduct(p.id, e.currentTarget.checked)}
                  disabled={busy || !allTeamProducts}
                />
              ))}
            </Stack>
          )}
        </Section>
      </Stack>
    </Drawer>
  )
}

function AddCandidateRow({
  user,
  onAdd,
  disabled
}: {
  user: UserSearchResult[number]
  onAdd: (role: TeamMemberRole) => void
  disabled: boolean
}) {
  const [role, setRole] = useState<TeamMemberRole>('member')
  return (
    <Group
      justify="space-between"
      px="sm"
      py={6}
      style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13 }}>{user.email}</div>
        {user.name && <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>{user.name}</div>}
      </div>
      <Group gap={4}>
        <Select
          size="xs"
          value={role}
          onChange={(v) => v && setRole(v as TeamMemberRole)}
          data={[
            { value: 'member', label: 'member' },
            { value: 'lead', label: 'lead' }
          ]}
          w={90}
        />
        <Button size="xs" variant="default" onClick={() => onAdd(role)} disabled={disabled}>
          Add
        </Button>
      </Group>
    </Group>
  )
}

function explain(err: unknown): string {
  return explainBase(err, {
    403: 'Admin permission required.',
    409: 'That slug is already taken.'
  })
}
