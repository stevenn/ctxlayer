import { useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  Code,
  CopyButton,
  Group,
  NumberInput,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
  Title
} from '@mantine/core'
import type { JoinCode } from '@ctxlayer/shared'
import {
  adminCreateJoinCode,
  adminRevokeJoinCode,
  fetchJoinCodes,
  type CreateJoinCodeInput
} from '../../lib/api'
import { bodyMessage, explain as explainBase } from '../../lib/explain'
import { absDate } from '../../lib/time'
import { useBusyAction } from '../../lib/use-busy'
import { useLoad } from '../../lib/use-load'
import { useDialogs } from '../../lib/dialogs'

/**
 * Admin · Join codes. A shared bearer secret distributed by an entity admin;
 * redeeming it admits per the code's policy (active | pending). The plaintext
 * is shown exactly once on creation. See docs/plan/L-entitlement.md.
 */
export function AdminJoinCodes() {
  const { confirm } = useDialogs()
  const [error, setError] = useState<string | null>(null)
  // The one-time plaintext of the just-created code (+ its label for context).
  const [fresh, setFresh] = useState<{ code: string; label: string } | null>(null)

  // Create form.
  const [label, setLabel] = useState('')
  const [domain, setDomain] = useState('')
  const [onRedeem, setOnRedeem] = useState<'active' | 'pending'>('active')
  const [maxUses, setMaxUses] = useState<number | ''>('')
  const [expiresInDays, setExpiresInDays] = useState<number | ''>('')

  const { data: items, reload } = useLoad(fetchJoinCodes, [], { explain, onError: setError })
  const { busy, run: withBusy } = useBusyAction({
    explain,
    // one error state shared with the load above
    setError
  })

  const create = () =>
    withBusy(async () => {
      const input: CreateJoinCodeInput = {
        label: label.trim() || undefined,
        domainRestrict: domain.trim() || null,
        onRedeem,
        maxUses: maxUses === '' ? null : maxUses,
        expiresInDays: expiresInDays === '' ? null : expiresInDays
      }
      const { code, joinCode } = await adminCreateJoinCode(input)
      setFresh({ code, label: joinCode.label })
      setLabel('')
      setDomain('')
      setOnRedeem('active')
      setMaxUses('')
      setExpiresInDays('')
      await reload()
    }, 'Create code')

  // The confirm dialog stays outside `withBusy` so the buttons don't show
  // busy while the dialog is open.
  async function revoke(jc: JoinCode) {
    const ok = await confirm({
      title: 'Revoke join code?',
      message: `Revoke ${jc.label || 'this code'}? Anyone holding it can no longer redeem it. This can't be undone.`,
      confirmLabel: 'Revoke',
      danger: true
    })
    if (!ok) return
    await withBusy(async () => {
      await adminRevokeJoinCode(jc.id)
      await reload()
    }, 'Revoke')
  }

  return (
    <>
      <Title order={2} fz={20} fw={600} mb="md">
        Admin · Join codes
      </Title>
      <Text c="dimmed" fz="sm" mb="md">
        Share a single code with a group; each sign-in that enters it is admitted. Optionally
        restrict to a domain, cap uses, or set an expiry. The code is shown once — copy it now.
      </Text>

      {fresh && (
        <Alert
          color="green"
          variant="light"
          radius="sm"
          mb="md"
          title="New join code — copy it now, it won't be shown again"
          withCloseButton
          onClose={() => setFresh(null)}
        >
          <Group gap="sm">
            <Code fz="md" fw={700}>
              {fresh.code}
            </Code>
            <CopyButton value={fresh.code}>
              {({ copied, copy }) => (
                <Button size="compact-xs" variant="default" onClick={copy}>
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              )}
            </CopyButton>
            {fresh.label && (
              <Text fz="xs" c="dimmed">
                {fresh.label}
              </Text>
            )}
          </Group>
        </Alert>
      )}

      <Stack gap="xs" mb="lg" maw={520}>
        <TextInput
          label="Label"
          placeholder="e.g. Engineering onboarding"
          value={label}
          onChange={(e) => setLabel(e.currentTarget.value)}
          disabled={busy}
        />
        <TextInput
          label="Restrict to domain (optional)"
          placeholder="visma.com"
          value={domain}
          onChange={(e) => setDomain(e.currentTarget.value)}
          disabled={busy}
        />
        <div>
          <Text fz="sm" fw={500} mb={4}>
            On redeem
          </Text>
          <SegmentedControl
            size="xs"
            value={onRedeem}
            onChange={(v) => setOnRedeem(v as 'active' | 'pending')}
            data={[
              { value: 'active', label: 'Admit (active)' },
              { value: 'pending', label: 'Request (pending)' }
            ]}
          />
        </div>
        <Group grow>
          <NumberInput
            label="Max uses (optional)"
            placeholder="unlimited"
            min={1}
            value={maxUses}
            onChange={(v) => setMaxUses(typeof v === 'number' ? v : '')}
            disabled={busy}
          />
          <NumberInput
            label="Expires in days (optional)"
            placeholder="never"
            min={1}
            max={365}
            value={expiresInDays}
            onChange={(v) => setExpiresInDays(typeof v === 'number' ? v : '')}
            disabled={busy}
          />
        </Group>
        <Group justify="flex-end">
          <Button size="xs" onClick={create} disabled={busy}>
            Create code
          </Button>
        </Group>
      </Stack>

      {error && (
        <Alert color="red" variant="light" radius="sm" mb="md">
          {error}
        </Alert>
      )}

      {!items && !error && <Text c="dimmed">Loading…</Text>}
      {items && items.length === 0 && <Text c="dimmed">No join codes yet.</Text>}

      {items && items.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Label</th>
              <th>Domain</th>
              <th>On redeem</th>
              <th>Uses</th>
              <th>Expires</th>
              <th>State</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((jc) => (
              <tr key={jc.id}>
                <td style={{ fontWeight: 500 }}>{jc.label || '—'}</td>
                <td className="text-muted">{jc.domainRestrict ?? 'any'}</td>
                <td className="text-muted">{jc.onRedeem}</td>
                <td className="text-muted">
                  {jc.uses}
                  {jc.maxUses != null ? ` / ${jc.maxUses}` : ''}
                </td>
                <td className="text-muted">{jc.expiresAt ? absDate(jc.expiresAt) : 'never'}</td>
                <td>
                  <CodeStateBadge jc={jc} />
                </td>
                <td style={{ textAlign: 'right' }}>
                  {!jc.revokedAt && (
                    <Button
                      size="compact-xs"
                      variant="subtle"
                      color="red"
                      onClick={() => revoke(jc)}
                      disabled={busy}
                    >
                      Revoke
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}

function codeState(jc: JoinCode): 'revoked' | 'expired' | 'used up' | 'active' {
  if (jc.revokedAt) return 'revoked'
  if (jc.expiresAt && Date.now() / 1000 >= jc.expiresAt) return 'expired'
  if (jc.maxUses != null && jc.uses >= jc.maxUses) return 'used up'
  return 'active'
}

function CodeStateBadge({ jc }: { jc: JoinCode }) {
  const s = codeState(jc)
  const color = s === 'active' ? 'green' : 'gray'
  return (
    <Badge color={color} variant={s === 'active' ? 'light' : 'outline'}>
      {s}
    </Badge>
  )
}

function explain(err: unknown): string {
  return explainBase(err, {
    403: 'Admin permission required.',
    400: (e) => bodyMessage(e) ?? 'Server rejected the request.'
  })
}
