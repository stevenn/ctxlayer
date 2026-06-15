import { Badge } from '@mantine/core'
import type { DocDetail } from '@ctxlayer/shared'
import type { CollabStatus } from '../../lib/yjs-ws-provider'

export function MetaRow({
  label,
  badge,
  children
}: {
  label: string
  // Optional trailing chip (e.g. the OKF badge) shown next to the label.
  badge?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 10,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: 'var(--text-dim)',
          marginBottom: 2
        }}
      >
        <span>{label}</span>
        {badge}
      </div>
      <div style={{ color: 'var(--text-muted)' }}>{children}</div>
    </div>
  )
}

export function CollabBadge({ canEdit, status }: { canEdit: boolean; status: CollabStatus }) {
  if (!canEdit) return <Badge variant="default">Read-only</Badge>
  switch (status) {
    case 'connected':
      return <Badge color="green">Live</Badge>
    case 'connecting':
      return <Badge color="blue">Connecting…</Badge>
    case 'reconnecting':
      return <Badge color="yellow">Reconnecting…</Badge>
    case 'disconnected':
      return <Badge color="red">Offline</Badge>
  }
}

export function Person({ u }: { u: DocDetail['createdBy'] }) {
  if (!u) return <span title="user no longer exists">—</span>
  const label = u.name && u.name.length > 0 ? u.name : u.email
  return <span title={u.email}>{label}</span>
}
