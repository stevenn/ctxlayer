import { useState } from 'react'
import { Badge, Button, Group, PasswordInput, Stack, Text } from '@mantine/core'
import type { AdminUpstreamRow } from '@ctxlayer/shared'
import { Section } from './helpers'

export function ConnectionSection({
  row,
  busy,
  onSaveBearer,
  onDisconnect,
  onSaveShared,
  onClearShared
}: {
  row: AdminUpstreamRow
  busy: boolean
  onSaveBearer: (token: string) => void
  onDisconnect: () => void
  onSaveShared: (token: string) => void
  onClearShared: () => void
}) {
  const [token, setToken] = useState('')
  const [sharedToken, setSharedToken] = useState('')

  const isUserBearer = row.authStrategy === 'user_bearer'
  const isUserOauth = row.authStrategy === 'user_oauth'
  const isShared = row.authStrategy === 'shared_bearer'
  const isNone = row.authStrategy === 'none'

  // Admin clicks Connect → OAuth start with return_to=admin so the
  // callback lands back here instead of /upstreams. Full-page nav
  // because OAuth needs real browser redirects.
  const startOauth = () => {
    window.location.assign(
      `/api/upstreams/${encodeURIComponent(row.id)}/oauth/start?return_to=admin`
    )
  }

  return (
    <Section title="Your connection">
      <Stack gap="xs">
        <Group gap="xs">
          <Text fz="xs" c="dimmed">
            Status
          </Text>
          <Badge
            color={row.currentUserConnected ? 'green' : 'gray'}
            variant={row.currentUserConnected ? 'filled' : 'light'}
          >
            {row.currentUserConnected ? 'connected' : 'not connected'}
          </Badge>
        </Group>

        {isNone && (
          <Text fz="xs" c="dimmed">
            This upstream uses <code>none</code> auth — no per-user credentials needed. Refresh and
            tool calls work for everyone with visibility, no setup required.
          </Text>
        )}

        {isShared && (
          <Stack gap="xs">
            <Text fz="xs" c="dimmed">
              One token shared across every user with visibility. The token is encrypted at rest and
              only decrypted to call the upstream.
              {row.sharedCredentialConfigured
                ? ' Paste a new value to rotate it.'
                : ' Paste a token to configure this upstream.'}
            </Text>
            <PasswordInput
              size="xs"
              aria-label="Shared token"
              placeholder={
                row.sharedCredentialConfigured
                  ? 'Paste a new shared token to replace the stored one…'
                  : 'Paste the shared token…'
              }
              value={sharedToken}
              onChange={(e) => setSharedToken(e.currentTarget.value)}
              disabled={busy}
            />
            <Group justify="flex-end" gap="xs">
              {row.sharedCredentialConfigured && (
                <Button
                  size="xs"
                  variant="subtle"
                  color="red"
                  onClick={onClearShared}
                  disabled={busy}
                >
                  Clear shared token
                </Button>
              )}
              <Button
                size="xs"
                onClick={() => {
                  if (!sharedToken.trim()) return
                  onSaveShared(sharedToken.trim())
                  setSharedToken('')
                }}
                disabled={!sharedToken.trim() || busy}
              >
                {row.sharedCredentialConfigured ? 'Replace token' : 'Configure'}
              </Button>
            </Group>
          </Stack>
        )}

        {isUserBearer && (
          <Stack gap="xs">
            <PasswordInput
              size="xs"
              aria-label="Personal access token"
              placeholder={
                row.currentUserConnected
                  ? 'Paste a new token to replace the stored one…'
                  : 'Paste a personal access token…'
              }
              value={token}
              onChange={(e) => setToken(e.currentTarget.value)}
              disabled={busy}
            />
            <Group justify="flex-end" gap="xs">
              {row.currentUserConnected && (
                <Button
                  size="xs"
                  variant="subtle"
                  color="red"
                  onClick={onDisconnect}
                  disabled={busy}
                >
                  Disconnect
                </Button>
              )}
              <Button
                size="xs"
                onClick={() => {
                  if (!token.trim()) return
                  onSaveBearer(token.trim())
                  setToken('')
                }}
                disabled={!token.trim() || busy}
              >
                {row.currentUserConnected ? 'Replace token' : 'Connect'}
              </Button>
            </Group>
          </Stack>
        )}

        {isUserOauth && (
          <Stack gap="xs">
            <Text fz="xs" c="dimmed">
              Connect signs you in at the upstream via OAuth (PKCE). ctxlayer stores the refresh
              token sealed at rest and transparently refreshes the access token as needed. The
              callback lands back here on this admin page.
            </Text>
            <Group justify="flex-end" gap="xs">
              {row.currentUserConnected && (
                <Button
                  size="xs"
                  variant="subtle"
                  color="red"
                  onClick={onDisconnect}
                  disabled={busy}
                >
                  Disconnect
                </Button>
              )}
              <Button size="xs" onClick={startOauth} disabled={busy}>
                {row.currentUserConnected ? 'Reconnect' : 'Connect with OAuth'}
              </Button>
            </Group>
          </Stack>
        )}
      </Stack>
    </Section>
  )
}
