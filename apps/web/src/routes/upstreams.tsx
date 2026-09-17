import { useState } from 'react'
import { Alert, Badge, Button, Card, Group, PasswordInput, Stack, Text, Title } from '@mantine/core'
import { Link } from 'react-router-dom'
import { GRANT_EXPIRY_WARN_DAYS, type UserUpstreamSummary } from '@ctxlayer/shared'
import { deleteUpstreamCredentials, fetchUpstreams, putUpstreamCredentials } from '../lib/api'
import { explain as explainBase } from '../lib/explain'
import { useBusyAction } from '../lib/use-busy'
import { useLoad } from '../lib/use-load'
import { useOAuthFlashBanner } from '../lib/use-oauth-banner'
import { useDialogs } from '../lib/dialogs'

export function Upstreams() {
  // One error channel shared by the list load and the per-card actions.
  const [error, setError] = useState<string | null>(null)
  const { data: items, reload } = useLoad(fetchUpstreams, [], { explain, onError: setError })
  const { banner: oauthBanner, clear: clearOauthBanner } = useOAuthFlashBanner()

  return (
    <Stack gap="md">
      <div>
        <Title order={2} fz={20} fw={600}>
          Connect upstreams
        </Title>
        <Text c="dimmed" fz="sm">
          MCP upstreams an admin has shared with your team or product. Connect via OAuth or paste a
          personal access token — credentials are encrypted at rest and only used to call the
          upstream on your behalf.
        </Text>
      </div>

      {oauthBanner && (
        <Alert
          color={oauthBanner.kind === 'ok' ? 'green' : 'red'}
          variant="light"
          radius="sm"
          withCloseButton
          onClose={clearOauthBanner}
        >
          {oauthBanner.message}
        </Alert>
      )}
      {error && (
        <Alert color="red" variant="light" radius="sm">
          {error}
        </Alert>
      )}
      {!items && !error && <Text c="dimmed">Loading…</Text>}
      {items && items.length === 0 && (
        <Text c="dimmed">
          No upstreams are visible to you yet. Ask an admin to grant your team or product access on
          the Admin · Upstreams page.
        </Text>
      )}

      {items && items.length > 0 && (
        <Stack gap="sm">
          {items.map((u) => (
            <UpstreamCard key={u.id} upstream={u} onChanged={() => reload()} onError={setError} />
          ))}
        </Stack>
      )}
    </Stack>
  )
}

function UpstreamCard({
  upstream,
  onChanged,
  onError
}: {
  upstream: UserUpstreamSummary
  onChanged: () => void
  onError: (msg: string) => void
}) {
  const dialogs = useDialogs()
  const [token, setToken] = useState('')
  const { busy, run: withBusy } = useBusyAction({
    explain,
    // Failures report to the parent's shared error banner; the parent owns
    // clearing it, so the pre-run null reset has nowhere to go.
    setError: (m) => {
      if (m) onError(m)
    }
  })

  const isUserBearer = upstream.authStrategy === 'user_bearer'
  const isOauth = upstream.authStrategy === 'user_oauth'
  const health = upstreamHealth(upstream, Date.now() / 1000)
  const isShared = upstream.authStrategy === 'shared_bearer'
  const isNone = upstream.authStrategy === 'none'

  async function save() {
    if (!token.trim()) return
    await withBusy(async () => {
      await putUpstreamCredentials(upstream.id, { token: token.trim() })
      setToken('')
      onChanged()
    }, 'Save')
  }

  // The confirm dialog stays outside `withBusy` so the buttons don't show
  // busy while the dialog is open.
  async function revoke() {
    const ok = await dialogs.confirm({
      title: 'Disconnect upstream?',
      message: `Disconnect ${upstream.displayName}? You'll need to paste the token again to reconnect.`,
      confirmLabel: 'Disconnect',
      danger: true
    })
    if (!ok) return
    await withBusy(async () => {
      await deleteUpstreamCredentials(upstream.id)
      onChanged()
    }, 'Revoke')
  }

  return (
    <Card withBorder radius="sm" padding="md">
      <Stack gap="xs">
        <Group justify="space-between" wrap="nowrap">
          <div style={{ minWidth: 0 }}>
            <Group gap="xs" wrap="nowrap">
              <Text fw={600} fz="md">
                {upstream.displayName}
              </Text>
              <Text fz="xs" c="dimmed">
                <code>{upstream.slug}</code> · {upstream.transport}
              </Text>
            </Group>
            {upstream.toolsCount > 0 ? (
              <Text fz="xs" c="dimmed">
                <Link to="/app/tools">
                  {`Browse ${upstream.toolsCount} tool${upstream.toolsCount === 1 ? '' : 's'} →`}
                </Link>
              </Text>
            ) : (
              <Text fz="xs" c="dimmed">
                Tool catalogue empty — refresh after connect
              </Text>
            )}
          </div>
          <Badge color={health.color} variant={health.kind === 'disconnected' ? 'light' : 'filled'}>
            {health.label}
          </Badge>
        </Group>

        {health.kind === 'needs_reauth' && (
          <Alert color="red" variant="light" p="xs">
            <Text fz="xs">
              Your authorization for {upstream.displayName} expired or was revoked, so agents can no
              longer use its tools — every call fails until you re-authorize here. Reconnecting the
              MCP connector in your AI client does not fix this.
            </Text>
          </Alert>
        )}
        {health.kind === 'expiring' && (
          <Alert color="yellow" variant="light" p="xs">
            <Text fz="xs">
              This authorization {health.detail}. {upstream.displayName} limits how long one sign-in
              lasts, and using it does not extend that — renew now to avoid losing its tools
              mid-task.
            </Text>
          </Alert>
        )}

        {isUserBearer && (
          <Stack gap="xs">
            <PasswordInput
              size="xs"
              aria-label="Personal access token"
              placeholder={
                upstream.connected
                  ? 'Paste a new token to replace the stored one…'
                  : 'Paste your personal access token…'
              }
              value={token}
              onChange={(e) => setToken(e.currentTarget.value)}
              disabled={busy}
            />
            <Group justify="flex-end" gap="xs">
              {upstream.connected && (
                <Button size="xs" variant="subtle" color="red" onClick={revoke} disabled={busy}>
                  Disconnect
                </Button>
              )}
              <Button size="xs" onClick={save} loading={busy} disabled={!token.trim()}>
                {upstream.connected ? 'Replace token' : 'Connect'}
              </Button>
            </Group>
          </Stack>
        )}

        {isOauth && (
          <Stack gap="xs">
            <Text fz="xs" c="dimmed">
              Connect signs you in at the upstream via OAuth (PKCE). ctxlayer stores the refresh
              token sealed at rest and transparently refreshes the access token as needed.
            </Text>
            <Group justify="flex-end" gap="xs">
              {upstream.connected && (
                <Button size="xs" variant="subtle" color="red" onClick={revoke} disabled={busy}>
                  Disconnect
                </Button>
              )}
              <Button
                size="xs"
                color={health.kind === 'needs_reauth' ? 'red' : undefined}
                onClick={() => {
                  // Full-page nav: the start endpoint 302s into the
                  // upstream's authorize URL. SPA state is rebuilt on
                  // return. `renew=1` forces a real sign-in: a plain
                  // reconnect of a healthy credential only refreshes the
                  // token, which does NOT restart a provider's fixed
                  // authorization lifetime.
                  const renew = health.renewable ? '?renew=1' : ''
                  window.location.assign(
                    `/api/upstreams/${encodeURIComponent(upstream.id)}/oauth/start${renew}`
                  )
                }}
                disabled={busy}
              >
                {health.action}
              </Button>
            </Group>
            {health.kind === 'connected' && health.detail && (
              <Text fz="xs" c="dimmed" ta="right">
                Authorization {health.detail}
              </Text>
            )}
          </Stack>
        )}

        {isNone && (
          <Text fz="xs" c="dimmed">
            No personal token needed — this upstream uses <code>none</code> (no auth required).
          </Text>
        )}

        {isShared && (
          <Text fz="xs" c="dimmed">
            {upstream.connected
              ? 'Configured by an admin — one shared token is used for everyone with access. Nothing for you to do.'
              : 'Awaiting admin configuration. An admin needs to set the shared token on this upstream before it can be used.'}
          </Text>
        )}
      </Stack>
    </Card>
  )
}

export type UpstreamHealthKind = 'disconnected' | 'needs_reauth' | 'expiring' | 'connected'

export interface UpstreamHealth {
  kind: UpstreamHealthKind
  label: string
  color: string
  /** OAuth button label for this state. */
  action: string
  /** True when the button should force a fresh sign-in (`?renew=1`). */
  renewable: boolean
  /** "expires in 2 days" / "expires today" / "valid until 12 Oct" — when known. */
  detail?: string
}

/**
 * The one place the card's badge, alert and OAuth button agree on what state
 * a connection is in. "A credential is on file" used to be the whole story,
 * so a dead authorization rendered as a green "connected". Pure + exported
 * for tests. `nowSec` is injected so the countdown is deterministic.
 */
export function upstreamHealth(
  u: Pick<UserUpstreamSummary, 'connected' | 'needsReauth' | 'authExpiresAt'>,
  nowSec: number
): UpstreamHealth {
  if (!u.connected) {
    return {
      kind: 'disconnected',
      label: 'disconnected',
      color: 'gray',
      action: 'Connect with OAuth',
      renewable: false
    }
  }
  if (u.needsReauth) {
    return {
      kind: 'needs_reauth',
      label: 're-authorize needed',
      color: 'red',
      action: 'Re-authorize',
      renewable: false // the dead credential already forces a real sign-in
    }
  }
  if (u.authExpiresAt == null) {
    return { kind: 'connected', label: 'connected', color: 'green', action: 'Reconnect', renewable: false }
  }
  const daysLeft = Math.floor((u.authExpiresAt - nowSec) / 86400)
  if (daysLeft < GRANT_EXPIRY_WARN_DAYS) {
    const detail =
      daysLeft <= 0 ? 'expires today' : daysLeft === 1 ? 'expires in 1 day' : `expires in ${daysLeft} days`
    return { kind: 'expiring', label: detail, color: 'yellow', action: 'Renew', renewable: true, detail }
  }
  const until = new Date(u.authExpiresAt * 1000).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short'
  })
  return {
    kind: 'connected',
    label: 'connected',
    color: 'green',
    action: 'Renew',
    renewable: true,
    detail: `valid until ${until}`
  }
}

function explain(err: unknown): string {
  return explainBase(err, {
    400: 'Server rejected the request. Check the token and try again.'
  })
}
