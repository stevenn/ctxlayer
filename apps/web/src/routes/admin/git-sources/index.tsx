import { useState } from 'react'
import { Alert, Badge, Button, Group, Text, Title } from '@mantine/core'
import type { AdminGitSourceRow } from '@ctxlayer/shared'
import { fetchAdminGitSources, fetchProducts } from '../../../lib/api'
import { useLoad } from '../../../lib/use-load'
import { explain, repoLabel } from './helpers'
import { CreateGitSourceModal } from './CreateGitSourceModal'
import { GitSourceDrawer } from './GitSourceDrawer'

export function AdminGitSources() {
  const { data: items, error, reload } = useLoad(fetchAdminGitSources, [], { explain })
  // Product names are cosmetic in the list — load failures are swallowed.
  const { data: products } = useLoad(fetchProducts, [], { onError: () => {} })
  const [createOpen, setCreateOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)

  const productName = (id: string | null) =>
    id ? (products?.find((p) => p.id === id)?.displayName ?? id) : '—'

  return (
    <>
      <Group justify="space-between" align="center" mb="md">
        <Title order={2} fz={20} fw={600}>
          Admin · Git repos
        </Title>
        <Button onClick={() => setCreateOpen(true)}>+ New git source</Button>
      </Group>

      {error && (
        <Alert color="red" variant="light" radius="sm" mb="md">
          {error}
        </Alert>
      )}
      {!items && !error && <Text c="dimmed">Loading…</Text>}
      {items && items.length === 0 && (
        <Text c="dimmed">
          No git sources yet. Click <strong>+ New git source</strong> to mirror a repo's markdown
          into the doc library.
        </Text>
      )}

      {items && items.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Display name</th>
              <th>Slug</th>
              <th>Provider</th>
              <th>Repo</th>
              <th>Branch</th>
              <th>Product</th>
              <th>Docs</th>
              <th>Last sync</th>
              <th>Enabled</th>
            </tr>
          </thead>
          <tbody>
            {items.map((g) => (
              <tr key={g.id} onClick={() => setEditingId(g.id)}>
                <td style={{ fontWeight: 500 }}>{g.displayName}</td>
                <td className="text-muted">
                  <code>{g.slug}</code>
                </td>
                <td className="text-muted">{g.provider}</td>
                <td className="text-muted">
                  <code style={{ fontSize: 12 }}>{repoLabel(g)}</code>
                </td>
                <td className="text-muted">{g.branch}</td>
                <td className="text-muted">{productName(g.productId)}</td>
                <td className="text-muted">{g.docCount}</td>
                <td>
                  <SyncBadge row={g} />
                </td>
                <td>
                  <Badge color={g.enabled ? 'green' : 'gray'} variant="light">
                    {g.enabled ? 'enabled' : 'disabled'}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <CreateGitSourceModal
        opened={createOpen}
        products={products}
        onClose={() => setCreateOpen(false)}
        onCreated={(id) => {
          setCreateOpen(false)
          reload()
          setEditingId(id)
        }}
      />

      {editingId && (
        <GitSourceDrawer
          sourceId={editingId}
          onClose={() => setEditingId(null)}
          onChanged={() => reload()}
          onDeleted={() => {
            setEditingId(null)
            reload()
          }}
        />
      )}
    </>
  )
}

function SyncBadge({ row }: { row: AdminGitSourceRow }) {
  if (!row.lastSyncStatus)
    return (
      <Badge variant="light" color="gray">
        never
      </Badge>
    )
  const color =
    row.lastSyncStatus === 'ok' ? 'green' : row.lastSyncStatus === 'partial' ? 'yellow' : 'red'
  return (
    <Badge variant="light" color={color} title={row.lastSyncError ?? undefined}>
      {row.lastSyncStatus}
    </Badge>
  )
}
