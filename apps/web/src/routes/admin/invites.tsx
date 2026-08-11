import { useState } from 'react'
import { Alert, Button, Group, Stack, Text, Textarea, Title } from '@mantine/core'
import type { Invite } from '@ctxlayer/shared'
import { adminCreateInvites, adminDeleteInvite, fetchInvites } from '../../lib/api'
import { bodyMessage, explain as explainBase } from '../../lib/explain'
import { absDate } from '../../lib/time'
import { useBusyAction } from '../../lib/use-busy'
import { useLoad } from '../../lib/use-load'
import { useDialogs } from '../../lib/dialogs'

/**
 * Admin · Invites. Pre-authorise emails — a matching sign-in is admitted
 * automatically (as `active`). Useful under any policy; required under the
 * `invite` ACCESS_POLICY. See docs/plan/L-entitlement.md.
 */
export function AdminInvites() {
  const { confirm } = useDialogs()
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [emails, setEmails] = useState('')

  const { data: items, reload } = useLoad(fetchInvites, [], { explain, onError: setError })
  const { busy, run: withBusy } = useBusyAction({
    explain,
    // one error state shared with the load above
    setError,
    onStart: () => setInfo(null)
  })

  const submit = () =>
    withBusy(async () => {
      const r = await adminCreateInvites(emails)
      const parts = [`${r.added} added`, `${r.skipped} skipped`]
      if (r.invalid.length) parts.push(`${r.invalid.length} invalid: ${r.invalid.join(', ')}`)
      setInfo(parts.join(' · '))
      setEmails('')
      await reload()
    }, 'Invite')

  // The confirm dialog stays outside `withBusy` so the buttons don't show
  // busy while the dialog is open.
  async function remove(inv: Invite) {
    const ok = await confirm({
      title: 'Delete invite?',
      message: `Remove the invite for ${inv.email}? They'll no longer be pre-authorised.`,
      confirmLabel: 'Delete',
      danger: true
    })
    if (!ok) return
    await withBusy(async () => {
      await adminDeleteInvite(inv.id)
      await reload()
    }, 'Delete')
  }

  return (
    <>
      <Title order={2} fz={20} fw={600} mb="md">
        Admin · Invites
      </Title>

      <Text c="dimmed" fz="sm" mb="md">
        Pre-authorise people by email. A matching sign-in is admitted automatically. Paste one or
        many addresses (comma, space, or newline separated).
      </Text>

      <Stack gap="xs" mb="lg">
        <Textarea
          aria-label="Email addresses to invite"
          placeholder={'alice@example.com\nbob@example.com'}
          value={emails}
          onChange={(e) => setEmails(e.currentTarget.value)}
          autosize
          minRows={2}
          maxRows={8}
          disabled={busy}
        />
        <Group justify="flex-end">
          <Button size="xs" onClick={submit} disabled={busy || !emails.trim()}>
            Invite
          </Button>
        </Group>
      </Stack>

      {error && (
        <Alert color="red" variant="light" radius="sm" mb="md">
          {error}
        </Alert>
      )}
      {info && (
        <Alert
          color="green"
          variant="light"
          radius="sm"
          mb="md"
          withCloseButton
          onClose={() => setInfo(null)}
        >
          {info}
        </Alert>
      )}

      {!items && !error && <Text c="dimmed">Loading…</Text>}
      {items && items.length === 0 && <Text c="dimmed">No invites yet.</Text>}

      {items && items.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Email</th>
              <th>Status</th>
              <th>Invited by</th>
              <th>Created</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((inv) => (
              <tr key={inv.id}>
                <td style={{ fontWeight: 500 }}>{inv.email}</td>
                <td className="text-muted">
                  {inv.redeemedAt ? `redeemed ${absDate(inv.redeemedAt)}` : 'pending'}
                </td>
                <td className="text-muted">{inv.invitedByEmail ?? '—'}</td>
                <td className="text-muted">{absDate(inv.createdAt)}</td>
                <td style={{ textAlign: 'right' }}>
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    color="red"
                    onClick={() => remove(inv)}
                    disabled={busy}
                  >
                    Delete
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}

function explain(err: unknown): string {
  return explainBase(err, {
    403: 'Admin permission required.',
    400: (e) => bodyMessage(e) ?? 'Server rejected the request.'
  })
}
