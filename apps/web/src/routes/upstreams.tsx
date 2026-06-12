import { useEffect, useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  PasswordInput,
  Stack,
  Text,
  Title,
  UnstyledButton
} from '@mantine/core'
import {
  mangleToolName,
  type UpstreamToolSummary,
  type UserUpstreamSummary
} from '@ctxlayer/shared'
import {
  deleteUpstreamCredentials,
  fetchUpstreams,
  fetchUserUpstreamTools,
  putUpstreamCredentials
} from '../lib/api'
import { explain as explainBase } from '../lib/explain'
import { useLoad } from '../lib/use-load'
import { useOAuthFlashBanner } from '../lib/use-oauth-banner'
import { useDialogs } from '../lib/dialogs'

type ToolsState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; tools: UpstreamToolSummary[] }

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
  const [busy, setBusy] = useState(false)
  const [toolsOpen, setToolsOpen] = useState(false)
  const [toolsState, setToolsState] = useState<ToolsState | undefined>()

  // Drop the cached tool list whenever the upstream's tools count
  // changes — e.g. after an admin refresh between renders. The next
  // expand will re-fetch.
  const knownCount = upstream.toolsCount
  useEffect(() => {
    setToolsState(undefined)
  }, [knownCount])

  // Lazy-load the catalogue on the first expand. We deliberately do
  // this from the click handler, not a useEffect with `toolsState` in
  // its deps — the latter triggers a deps-changed cleanup the moment
  // we setState(loading), which aborts the request before it resolves.
  async function loadTools() {
    setToolsState({ kind: 'loading' })
    try {
      const res = await fetchUserUpstreamTools(upstream.id)
      setToolsState({ kind: 'ready', tools: res.tools })
    } catch (err) {
      setToolsState({ kind: 'error', message: explain(err) })
    }
  }

  function toggleTools() {
    setToolsOpen((open) => {
      const next = !open
      if (next && !toolsState) {
        void loadTools()
      }
      return next
    })
  }

  const isUserBearer = upstream.authStrategy === 'user_bearer'
  const isOauth = upstream.authStrategy === 'user_oauth'
  const isShared = upstream.authStrategy === 'shared_bearer'
  const isNone = upstream.authStrategy === 'none'

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
    const ok = await dialogs.confirm({
      title: 'Disconnect upstream?',
      message: `Disconnect ${upstream.displayName}? You'll need to paste the token again to reconnect.`,
      confirmLabel: 'Disconnect',
      danger: true
    })
    if (!ok) return
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
            {upstream.toolsCount > 0 ? (
              <UnstyledButton
                onClick={toggleTools}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
              >
                <ExpandChevron open={toolsOpen} />
                <Text fz="xs" c="dimmed">
                  {`${upstream.toolsCount} tool${upstream.toolsCount === 1 ? '' : 's'} cached`}
                </Text>
              </UnstyledButton>
            ) : (
              <Text fz="xs" c="dimmed">
                Tool catalogue empty — refresh after connect
              </Text>
            )}
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

        {toolsOpen && (
          <div style={{ marginTop: 6 }}>
            <ToolsExpansion slug={upstream.slug} state={toolsState} />
          </div>
        )}
      </Stack>
    </Card>
  )
}

function ToolsExpansion({ slug, state }: { slug: string; state: ToolsState | undefined }) {
  if (!state || state.kind === 'loading') {
    return (
      <Text c="dimmed" fz="xs">
        Loading tools…
      </Text>
    )
  }
  if (state.kind === 'error') {
    return (
      <Alert color="red" variant="light" radius="sm">
        {state.message}
      </Alert>
    )
  }
  if (state.tools.length === 0) {
    return (
      <Text c="dimmed" fz="xs">
        No tools cached yet. An admin can populate the catalogue via Admin · Upstreams → Refresh
        tools.
      </Text>
    )
  }
  return (
    <table className="data-table" style={{ marginTop: 0 }}>
      <thead>
        <tr>
          <th style={{ width: '34%' }}>Agent-visible name</th>
          <th>Description</th>
        </tr>
      </thead>
      <tbody>
        {state.tools.map((t) => (
          <tr key={t.toolName}>
            <td>
              <code style={{ fontSize: 11 }}>{mangleToolName(slug, t.toolName)}</code>
            </td>
            <td className="text-muted" style={{ fontSize: 12 }}>
              {t.description ?? <span style={{ opacity: 0.5 }}>—</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function ExpandChevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={12}
      height={12}
      style={{
        display: 'inline-block',
        verticalAlign: 'middle',
        transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
        transition: 'transform 120ms ease',
        color: 'var(--text-muted)'
      }}
      aria-hidden="true"
    >
      <path
        d="M6 3.5 L10.5 8 L6 12.5"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function explain(err: unknown): string {
  return explainBase(err, {
    400: 'Server rejected the request. Check the token and try again.'
  })
}
