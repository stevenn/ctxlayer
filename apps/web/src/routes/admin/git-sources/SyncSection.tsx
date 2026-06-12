import { useState } from 'react'
import { Button, Group, PasswordInput, Stack, Text } from '@mantine/core'
import type { AdminGitSourceRow } from '@ctxlayer/shared'
import { Section } from './helpers'

export function SyncSection({
  row,
  busy,
  onSetToken,
  onClearToken,
  onSyncNow
}: {
  row: AdminGitSourceRow
  busy: boolean
  onSetToken: (token: string) => void
  onClearToken: () => void
  onSyncNow: () => void
}) {
  const [token, setToken] = useState('')
  const lastSynced = row.lastSyncedAt ? new Date(row.lastSyncedAt * 1000).toLocaleString() : 'never'

  return (
    <Section title="Read token & sync">
      <Stack gap="xs">
        <Text fz="xs" c="dimmed">
          Read strategy: <code>{row.readStrategy}</code>. The shared org token is used for
          unattended (cron) sync. Stored encrypted at rest.
          {row.sharedCredentialConfigured ? ' Paste a new value to rotate it.' : ''}
        </Text>
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
              <Text fz="xs" c="red">
                {row.lastSyncError}
              </Text>
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
