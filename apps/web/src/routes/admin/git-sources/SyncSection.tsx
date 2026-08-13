import { useState } from 'react'
import { Button, Group, PasswordInput, Stack, Text } from '@mantine/core'
import type { AdminGitSourceRow } from '@ctxlayer/shared'
import { gitSyncErrorMessage } from '../../../lib/git-sync-error'
import { Section } from './helpers'

export function SyncSection({
  row,
  busy,
  onSetToken,
  onClearToken,
  onSyncNow,
  onUseMyIdentity,
  onClearIdentity
}: {
  row: AdminGitSourceRow
  busy: boolean
  onSetToken: (token: string) => void
  onClearToken: () => void
  onSyncNow: () => void
  onUseMyIdentity: () => void
  onClearIdentity: () => void
}) {
  const [token, setToken] = useState('')
  const lastSynced = row.lastSyncedAt ? new Date(row.lastSyncedAt * 1000).toLocaleString() : 'never'
  const friendlyError = row.lastSyncError ? gitSyncErrorMessage(row.lastSyncError) : ''
  const userRead = row.readStrategy !== 'shared_bearer'

  return (
    <Section title="Read token & sync">
      <Stack gap="xs">
        <Text fz="xs" c="dimmed">
          Read strategy: <code>{row.readStrategy}</code>. The shared org token is used for
          unattended (cron) sync. Stored encrypted at rest.
          {row.sharedCredentialConfigured ? ' Paste a new value to rotate it.' : ''}
        </Text>
        {userRead && (
          <Group justify="space-between" align="center" wrap="nowrap">
            {row.syncAsUser ? (
              <>
                <Text fz="xs">
                  Scheduled sync runs with <strong>{row.syncAsUser.email}</strong>'s connection.
                </Text>
                <Button size="xs" variant="subtle" color="red" onClick={onClearIdentity} disabled={busy}>
                  Stop scheduled sync
                </Button>
              </>
            ) : (
              <>
                <Text fz="xs" c="orange">
                  Scheduled sync is OFF — a user-connected read strategy needs a designated
                  identity (or use Sync now).
                </Text>
                <Button
                  size="xs"
                  variant="default"
                  onClick={onUseMyIdentity}
                  disabled={busy || !row.currentUserConnected}
                  title={
                    row.currentUserConnected
                      ? 'Scheduled syncs will use your stored OAuth connection'
                      : 'Connect your own credential for this source first'
                  }
                >
                  Use my connection
                </Button>
              </>
            )}
          </Group>
        )}
        <PasswordInput
          size="xs"
          aria-label="Read token (personal access token)"
          placeholder={
            row.sharedCredentialConfigured
              ? 'Paste a new PAT to replace the stored one…'
              : 'Paste a personal access token (repo read scope)…'
          }
          value={token}
          onChange={(e) => setToken(e.currentTarget.value)}
          disabled={busy}
        />
        <Group justify="space-between">
          <div>
            <Text fz="xs" c="dimmed">
              Last sync
            </Text>
            <Text fz="sm">
              {lastSynced}
              {row.lastSyncStatus ? ` · ${row.lastSyncStatus}` : ''}
            </Text>
            {row.lastSyncError && (
              <>
                <Text fz="xs" c="red">
                  {friendlyError}
                </Text>
                {friendlyError !== row.lastSyncError && (
                  <Text fz="xs" c="dimmed" ff="monospace">
                    {row.lastSyncError}
                  </Text>
                )}
              </>
            )}
          </div>
          <Group gap="xs">
            {row.sharedCredentialConfigured && (
              <Button size="xs" variant="subtle" color="red" onClick={onClearToken} disabled={busy}>
                Clear token
              </Button>
            )}
            <Button
              size="xs"
              variant="default"
              onClick={() => {
                if (!token.trim()) return
                onSetToken(token.trim())
                setToken('')
              }}
              disabled={!token.trim() || busy}
            >
              {row.sharedCredentialConfigured ? 'Replace token' : 'Set token'}
            </Button>
            <Button size="xs" onClick={onSyncNow} disabled={busy}>
              Sync now
            </Button>
          </Group>
        </Group>
      </Stack>
    </Section>
  )
}
