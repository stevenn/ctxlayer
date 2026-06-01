import { Alert, Button, Group, Stack, Text } from '@mantine/core'
import type { AdminUpstreamRow } from '@ctxlayer/shared'
import { Section } from './helpers'

export function ToolsCacheSection({
  row,
  busy,
  onRefresh
}: {
  row: AdminUpstreamRow
  busy: boolean
  onRefresh: () => void
}) {
  const cachedAt = row.toolsCachedAt ? new Date(row.toolsCachedAt * 1000).toLocaleString() : 'never'
  const needsAdminConnection =
    row.authStrategy === 'user_bearer' || row.authStrategy === 'user_oauth'

  return (
    <Section title="Tool catalogue cache">
      <Stack gap={6}>
        <Group gap="md">
          <div>
            <Text fz="xs" c="dimmed">
              Cached tools
            </Text>
            <Text fw={600} fz="lg">
              {row.toolsCount}
            </Text>
          </div>
          <div>
            <Text fz="xs" c="dimmed">
              Last refreshed
            </Text>
            <Text fz="sm">{cachedAt}</Text>
          </div>
        </Group>
        {needsAdminConnection && (
          <Alert color="gray" variant="light" radius="sm">
            <Text fz="xs">
              Refresh uses <strong>your own</strong> connection. If you haven't{' '}
              {row.authStrategy === 'user_oauth' ? 'completed the OAuth flow' : 'pasted a token'}{' '}
              for this upstream on <code>/upstreams</code> yet, do that first.
            </Text>
          </Alert>
        )}
        <Group justify="flex-end">
          <Button size="xs" variant="default" onClick={onRefresh} disabled={busy}>
            Refresh now
          </Button>
        </Group>
      </Stack>
    </Section>
  )
}
