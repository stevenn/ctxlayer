import { Stack, Text } from '@mantine/core'
import type { AdminGitSourceRow, GitCredStrategy, GitSyncInterval } from '@ctxlayer/shared'
import { explain as explainBase } from '../../../lib/explain'

export const STRATEGY_OPTIONS: { value: GitCredStrategy; label: string }[] = [
  { value: 'shared_bearer', label: 'Shared org token (PAT)' },
  { value: 'user_bearer', label: 'Per-user token (PAT)' },
  { value: 'user_oauth', label: 'Per-user OAuth' }
]

export const INTERVAL_OPTIONS: { value: GitSyncInterval; label: string }[] = [
  { value: 'hourly', label: 'Hourly' },
  { value: '6x_daily', label: '6× daily' },
  { value: '2x_daily', label: '2× daily' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' }
]

export function repoLabel(g: AdminGitSourceRow): string {
  return g.owner ? `${g.owner}/${g.repo}` : g.repo
}

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div
        style={{
          fontSize: 10,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: 'var(--text-dim)',
          marginBottom: 6
        }}
      >
        {title}
      </div>
      {children}
    </div>
  )
}

export function SubSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <Text fz="xs" fw={500} mb={4}>
        {title}
      </Text>
      <Stack gap={4}>{children}</Stack>
    </div>
  )
}

export function explain(err: unknown): string {
  return explainBase(err, {
    403: 'Admin permission required.',
    409: 'That slug is already taken.',
    400: (e) => {
      const body = e.body as { error?: string } | null
      return body?.error ? `Rejected: ${body.error}` : 'Server rejected the request.'
    }
  })
}
