import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  PasswordInput,
  Stack,
  Text,
  Title
} from '@mantine/core'
import type { UserUpstreamSummary } from '@ctxlayer/shared'
import {
  ApiError,
  ApiSchemaError,
  deleteUpstreamCredentials,
  fetchUpstreams,
  putUpstreamCredentials
} from '../lib/api'

export function Upstreams() {
  const [items, setItems] = useState<UserUpstreamSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [oauthBanner, setOauthBanner] = useState<{ kind: 'ok' | 'err'; message: string } | null>(null)

  const reload = useCallback(async (signal?: AbortSignal) => {
    try {
      const list = await fetchUpstreams(signal)
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

  // OAuth callback flashes `?oauth_connected=<slug>` or
  // `?oauth_error=<code>&desc=<...>` on the redirect URL — surface
  // them and clean the URL so a reload doesn't re-show the banner.
  useMemo(() => {
    const params = new URLSearchParams(window.location.search)
    const connected = params.get('oauth_connected')
    const errCode = params.get('oauth_error')
    if (connected) {
      setOauthBanner({ kind: 'ok', message: `Connected ${connected}.` })
    } else if (errCode) {
      const desc = params.get('desc') ?? ''
      setOauthBanner({ kind: 'err', message: `OAuth failed: ${errCode}${desc ? ` — ${desc}` : ''}` })
    }
    if (connected || errCode) {
      params.delete('oauth_connected')
      params.delete('oauth_error')
      params.delete('desc')
      const qs = params.toString()
      window.history.replaceState({}, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`)
    }
  }, [])

  return (
    <Stack gap="md">
      <div>
        <Title order={2} fz={20} fw={600}>
          Connect upstreams
        </Title>
        <Text c="dimmed" fz="sm">
          MCP upstreams an admin has shared with your team or product. Connect
          via OAuth or paste a personal access token — credentials are
          encrypted at rest and only used to call the upstream on your behalf.
        </Text>
      </div>

      {oauthBanner && (
        <Alert
          color={oauthBanner.kind === 'ok' ? 'green' : 'red'}
          variant="light"
          radius="sm"
          withCloseButton
          onClose={() => setOauthBanner(null)}
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
          No upstreams are visible to you yet. Ask an admin to grant your team
          or product access on the Admin · Upstreams page.
        </Text>
      )}

      {items && items.length > 0 && (
        <Stack gap="sm">
          {items.map((u) => (
            <UpstreamCard
              key={u.id}
              upstream={u}
              onChanged={() => reload()}
              onError={setError}
            />
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
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)

  const isUserBearer = upstream.authStrategy === 'user_bearer'
  const isOauth = upstream.authStrategy === 'user_oauth'
  const isNoAuthNeeded =
    upstream.authStrategy === 'none' || upstream.authStrategy === 'shared_bearer'

  async function save() {
    if (!token.trim()) return
    setBusy(true)
    try {
      await putUpstreamCredentials(upstream.id, { token: token.trim() })
      setToken('')
      onChanged()
    } catch (err) {
      onError(`Save failed: ${explain(err)}`)
    } finally {
      setBusy(false)
    }
  }

  async function revoke() {
    if (!confirm(`Disconnect ${upstream.displayName}? You'll need to paste the token again to reconnect.`)) {
      return
    }
    setBusy(true)
    try {
      await deleteUpstreamCredentials(upstream.id)
      onChanged()
    } catch (err) {
      onError(`Revoke failed: ${explain(err)}`)
    } finally {
      setBusy(false)
    }
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
            <Text fz="xs" c="dimmed">
              {upstream.toolsCount > 0
                ? `${upstream.toolsCount} tool${upstream.toolsCount === 1 ? '' : 's'} cached`
                : 'Tool catalogue empty — refresh after connect'}
            </Text>
          </div>
          <Badge
            color={upstream.connected ? 'green' : 'gray'}
            variant={upstream.connected ? 'filled' : 'light'}
          >
            {upstream.connected ? 'connected' : 'disconnected'}
          </Badge>
        </Group>

        {isUserBearer && (
          <Stack gap="xs">
            <PasswordInput
              size="xs"
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
                <Button
                  size="xs"
                  variant="subtle"
                  color="red"
                  onClick={revoke}
                  disabled={busy}
                >
                  Disconnect
                </Button>
              )}
              <Button
                size="xs"
                onClick={save}
                loading={busy}
                disabled={!token.trim()}
              >
                {upstream.connected ? 'Replace token' : 'Connect'}
              </Button>
            </Group>
          </Stack>
        )}

        {isOauth && (
          <Stack gap="xs">
            <Text fz="xs" c="dimmed">
              Connect signs you in at the upstream via OAuth (PKCE).
              ctxlayer stores the refresh token sealed at rest and
              transparently refreshes the access token as needed.
            </Text>
            <Group justify="flex-end" gap="xs">
              {upstream.connected && (
                <Button
                  size="xs"
                  variant="subtle"
                  color="red"
                  onClick={revoke}
                  disabled={busy}
                >
                  Disconnect
                </Button>
              )}
              <Button
                size="xs"
                onClick={() => {
                  // Full-page nav: the start endpoint 302s into the
                  // upstream's authorize URL. SPA state is rebuilt on
                  // return.
                  window.location.assign(
                    `/api/upstreams/${encodeURIComponent(upstream.id)}/oauth/start`
                  )
                }}
                disabled={busy}
              >
                {upstream.connected ? 'Reconnect' : 'Connect with OAuth'}
              </Button>
            </Group>
          </Stack>
        )}

        {isNoAuthNeeded && (
          <Text fz="xs" c="dimmed">
            No personal token needed — this upstream uses{' '}
            <code>{upstream.authStrategy}</code> credentials managed by an
            admin.
          </Text>
        )}
      </Stack>
    </Card>
  )
}

function explain(err: unknown): string {
  if (err instanceof ApiError && err.status === 401) {
    return 'Your session expired. Refresh to sign in again.'
  }
  if (err instanceof ApiError && err.status === 400) {
    return 'Server rejected the request. Check the token and try again.'
  }
  if (err instanceof ApiError) return `Server returned HTTP ${err.status}.`
  if (err instanceof ApiSchemaError) {
    return 'Server returned an unexpected response shape.'
  }
  if (err instanceof Error) return err.message
  return 'Could not reach the server.'
}
