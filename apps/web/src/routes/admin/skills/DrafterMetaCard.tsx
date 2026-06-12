import { Alert, Stack, Text } from '@mantine/core'

/**
 * Shown at the top of the skill drawer when the skill was AI-drafted.
 * Reads opaque JSON from `skills.drafter_meta`, surfaces the model +
 * version + which context inputs were used so the reviewer knows what
 * scrutiny to apply.
 */
export function DrafterMetaCard({ meta }: { meta: unknown }) {
  if (!meta || typeof meta !== 'object') return null
  const m = meta as {
    from?: string
    model?: string
    promptVersion?: string
    contextInputs?: unknown
    draftedAt?: number
    costUsd?: number
  }
  if (!m.from) return null
  const inputs = Array.isArray(m.contextInputs)
    ? (m.contextInputs as unknown[]).filter((x): x is string => typeof x === 'string')
    : []
  const when = m.draftedAt ? new Date(m.draftedAt * 1000).toLocaleString() : 'unknown'
  const sourceLabel =
    m.from === 'cli+claude-code'
      ? 'Claude Code CLI'
      : m.from === 'cli+claude-code+agentic'
        ? 'Claude Code CLI (agentic)'
        : m.from
  return (
    <Alert color="violet" variant="light" radius="sm" title="AI-drafted skill">
      <Stack gap={4}>
        <Text fz="xs">
          <strong>Source:</strong> {sourceLabel}
          {m.model && m.model !== 'unknown' ? ` (${m.model})` : ''}
        </Text>
        {inputs.length > 0 && (
          <Text fz="xs">
            <strong>Context inputs:</strong> {inputs.join(', ')}
          </Text>
        )}
        <Text fz="xs" c="dimmed">
          Drafted {when}
          {typeof m.costUsd === 'number' && m.costUsd > 0 ? ` · ~$${m.costUsd.toFixed(4)}` : ''}
          {m.promptVersion ? ` · prompt ${m.promptVersion}` : ''}
        </Text>
      </Stack>
    </Alert>
  )
}
