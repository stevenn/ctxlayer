import { Button, Group, Stack, Text } from '@mantine/core'
import { Section } from './helpers'

/**
 * Stands in for the visibility + tool-access editors on a private upstream:
 * it has exactly one audience (its owner), so there is nothing to grant.
 * "Share with org" is the one-way exit — afterwards the usual editors appear
 * and the upstream stays invisible to others until visibility is granted.
 */
export function PrivateSection({ busy, onShare }: { busy: boolean; onShare: () => void }) {
  return (
    <Section title="Visibility">
      <Stack gap={6}>
        <Text fz="sm">
          <strong>Private.</strong> Only you can see and use this upstream — other users and admins
          don't see it anywhere. Visibility rules, per-tool access and skill/doc attachments become
          available once it is shared.
        </Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={onShare} disabled={busy}>
            Share with org…
          </Button>
        </Group>
      </Stack>
    </Section>
  )
}
