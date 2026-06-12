import { useState } from 'react'
import { useSlugSuggest } from '../../lib/use-slug-suggest'
import { Alert, Button, Drawer, Group, Modal, Stack, Text, TextInput, Title } from '@mantine/core'
import type { AdminRoleRow } from '@ctxlayer/shared'
import { clickableRow } from '../../lib/a11y'
import { adminCreateRole, adminDeleteRole, adminPatchRole, fetchAdminRoles } from '../../lib/api'
import { explain as explainBase } from '../../lib/explain'
import { useBusyAction } from '../../lib/use-busy'
import { useLoad } from '../../lib/use-load'
import { useDrawerConfirm } from '../../lib/dialogs'

/**
 * Admin · Roles — the cross-cutting org-role axis (engineering, qa,
 * product). Roles gate whole upstreams (Admin · Upstreams → Visibility)
 * and individual tools (→ Tool access). Membership is assigned per-user
 * on Admin · Users. This page only edits the role records.
 */
export function AdminRoles() {
  const { data: roles, error, reload } = useLoad(fetchAdminRoles, [], { explain })
  const [createOpen, setCreateOpen] = useState(false)
  const [editing, setEditing] = useState<AdminRoleRow | null>(null)

  return (
    <>
      <Group justify="space-between" align="center" mb="md">
        <Title order={2} fz={20} fw={600}>
          Admin · Roles
        </Title>
        <Button onClick={() => setCreateOpen(true)}>+ New role</Button>
      </Group>

      <Text fz="xs" c="dimmed" mb="md">
        Roles cut across teams (a user has a team <em>and</em> one-or-more roles). Use them to gate
        upstreams + individual tools. Assign members on Admin · Users.
      </Text>

      {error && (
        <Alert color="red" variant="light" radius="sm" mb="md">
          {error}
        </Alert>
      )}
      {!roles && !error && <Text c="dimmed">Loading…</Text>}

      {roles && roles.length === 0 && (
        <Text c="dimmed">
          No roles yet. Click <strong>+ New role</strong> to create the first one (e.g. engineering,
          qa, product).
        </Text>
      )}

      {roles && roles.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Display name</th>
              <th>Slug</th>
              <th>Description</th>
              <th>Members</th>
            </tr>
          </thead>
          <tbody>
            {roles.map((r) => (
              <tr key={r.id} {...clickableRow(() => setEditing(r))}>
                <td style={{ fontWeight: 500 }}>{r.displayName}</td>
                <td className="text-muted">
                  <code>{r.slug}</code>
                </td>
                <td className="text-muted">{r.description ?? '—'}</td>
                <td className="text-muted">{r.memberCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {createOpen && (
        <CreateRoleModal
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false)
            reload()
          }}
        />
      )}

      {editing && (
        <RoleDrawer
          role={editing}
          onClose={() => setEditing(null)}
          onChanged={() => reload()}
          onDeleted={() => {
            setEditing(null)
            reload()
          }}
        />
      )}
    </>
  )
}

// ----- Create modal ------------------------------------------------------

// Conditionally mounted by the caller (`{createOpen && <CreateRoleModal/>}`),
// so all state resets for free on close — no `opened` prop / reset effect.
function CreateRoleModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [displayName, setDisplayName] = useState('')
  const slugField = useSlugSuggest('role', displayName)
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    if (!slugField.slug.trim() || !displayName.trim()) return
    setBusy(true)
    setError(null)
    try {
      await adminCreateRole({
        slug: slugField.slug.trim(),
        displayName: displayName.trim(),
        description: description.trim() || null
      })
      onCreated()
    } catch (err) {
      setError(explain(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal opened onClose={onClose} title="New role" centered>
      <Stack gap="md">
        <TextInput
          label="Display name"
          placeholder="Engineering"
          value={displayName}
          onChange={(e) => setDisplayName(e.currentTarget.value)}
        />
        <TextInput
          label="Slug"
          placeholder="role-engineering"
          value={slugField.slug}
          onChange={(e) => slugField.setSlug(e.currentTarget.value)}
          description="Auto-filled from the name; edit to customise. Must start with role-."
        />
        <TextInput
          label="Description"
          placeholder="Optional"
          value={description}
          onChange={(e) => setDescription(e.currentTarget.value)}
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

// ----- Edit drawer -------------------------------------------------------

function RoleDrawer({
  role,
  onClose,
  onChanged,
  onDeleted
}: {
  role: AdminRoleRow
  onClose: () => void
  onChanged: () => void
  onDeleted: () => void
}) {
  const { hidden, confirm, reveal } = useDrawerConfirm()
  const [slug, setSlug] = useState(role.slug)
  const [displayName, setDisplayName] = useState(role.displayName)
  const [description, setDescription] = useState(role.description ?? '')
  const {
    busy,
    error,
    run: withBusy
  } = useBusyAction({
    explain,
    // a delete that hid the drawer then failed must show the error
    onError: reveal
  })

  const savePatch = () =>
    withBusy(async () => {
      const trimmedSlug = slug.trim()
      await adminPatchRole(role.id, {
        // Send slug only when it actually changed (grandfathered roles can
        // be edited without being forced to re-slug; the role- prefix is
        // enforced only on a real rename).
        ...(trimmedSlug !== role.slug ? { slug: trimmedSlug } : {}),
        displayName: displayName.trim(),
        description: description.trim() || null
      })
      onChanged()
    }, 'Save')

  const onDelete = () =>
    withBusy(async () => {
      const ok = await confirm(
        {
          title: 'Delete role?',
          message: `Delete role "${role.displayName}"? Members lose it, and any upstream/tool ACL that grants only this role stops matching anyone (safe deny direction).`,
          confirmLabel: 'Delete',
          danger: true
        },
        { keepHiddenOnConfirm: true }
      )
      if (!ok) return
      await adminDeleteRole(role.id)
      onDeleted()
    }, 'Delete')

  return (
    <Drawer
      opened={!hidden}
      onClose={onClose}
      title={`Role · ${role.displayName}`}
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
          <Text fz="xs" c="dimmed">
            {role.memberCount} member{role.memberCount === 1 ? '' : 's'} — assign on Admin · Users →
            drawer → Roles.
          </Text>
          <Group justify="flex-end" gap="xs">
            <Button variant="default" color="red" onClick={onDelete} disabled={busy}>
              Delete
            </Button>
            <Button onClick={savePatch} loading={busy}>
              Save
            </Button>
          </Group>
        </Stack>
      </Stack>
    </Drawer>
  )
}

function explain(err: unknown): string {
  return explainBase(err, {
    403: 'Admin permission required.',
    409: 'That slug is already taken.'
  })
}
