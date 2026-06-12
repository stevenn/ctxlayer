import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Alert, Badge, Button, Group, Select, Text, TextInput, Title } from '@mantine/core'
import { fetchSkills } from '../../../lib/api'
import { relativeTime } from '../../../lib/time'
import { useLoad } from '../../../lib/use-load'
import { explain } from './helpers'
import { CreateSkillModal } from './CreateSkillModal'
import { SkillDrawer } from './SkillDrawer'

type StatusFilter = 'all' | 'draft' | 'published' | 'archived'

export function AdminSkills() {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [query, setQuery] = useState('')
  const nav = useNavigate()

  const {
    data: items,
    error,
    reload
  } = useLoad(
    (signal) => fetchSkills({ status: statusFilter === 'all' ? undefined : statusFilter }, signal),
    [statusFilter],
    { explain }
  )

  const filtered = useMemo(() => {
    if (!items) return null
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        s.slug.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q)
    )
  }, [items, query])

  return (
    <>
      <Group justify="space-between" align="center" mb="md">
        <Title order={2} fz={20} fw={600}>
          Admin · Skills
        </Title>
        <Group gap="xs">
          <Select
            size="xs"
            value={statusFilter}
            onChange={(v) => setStatusFilter((v as StatusFilter) ?? 'all')}
            data={[
              { value: 'all', label: 'All' },
              { value: 'draft', label: 'Draft' },
              { value: 'published', label: 'Published' },
              { value: 'archived', label: 'Archived' }
            ]}
            w={140}
          />
          <TextInput
            size="xs"
            placeholder="Filter by title or slug…"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            w={260}
          />
          <Button size="xs" onClick={() => setCreating(true)}>
            New skill
          </Button>
        </Group>
      </Group>

      {error && (
        <Alert color="red" variant="light" radius="sm" mb="md">
          {error}
        </Alert>
      )}
      {!items && !error && <Text c="dimmed">Loading…</Text>}

      {items && items.length === 0 && (
        <Text c="dimmed">
          No skills yet. Click <b>New skill</b> above to create the first one.
        </Text>
      )}

      {filtered && filtered.length === 0 && items && items.length > 0 && (
        <Text c="dimmed">No skills match "{query}".</Text>
      )}

      {filtered && filtered.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Title</th>
              <th>Slug</th>
              <th>Status</th>
              <th>Description</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((s) => (
              <tr key={s.id} onClick={() => setEditingId(s.id)}>
                <td style={{ fontWeight: 500 }}>
                  <Group gap="xs" wrap="nowrap">
                    <span>{s.title}</span>
                    {s.isStale && (
                      <Badge
                        color="yellow"
                        variant="light"
                        title="Attached upstream tool schema changed after this skill's last edit — review."
                      >
                        Stale
                      </Badge>
                    )}
                  </Group>
                </td>
                <td className="text-muted">
                  <code style={{ fontSize: 11 }}>{s.slug}</code>
                </td>
                <td>
                  <StatusBadge status={s.status} />
                </td>
                <td className="text-muted" style={{ maxWidth: 380 }}>
                  <Text fz="xs" c="dimmed" lineClamp={1}>
                    {s.description}
                  </Text>
                </td>
                <td className="text-muted">{relativeTime(s.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editingId && (
        <SkillDrawer
          skillId={editingId}
          onClose={() => setEditingId(null)}
          onChanged={() => reload()}
          onOpenEditor={(id) => {
            setEditingId(null)
            nav(`/app/admin/skills/${id}/edit`)
          }}
        />
      )}

      {creating && (
        <CreateSkillModal
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false)
            nav(`/app/admin/skills/${id}/edit`)
          }}
        />
      )}
    </>
  )
}

// ----- Status badge ------------------------------------------------------

function StatusBadge({ status }: { status: 'draft' | 'published' | 'archived' }) {
  const colour = status === 'published' ? 'green' : status === 'draft' ? 'yellow' : 'gray'
  return (
    <Badge color={colour} variant={status === 'published' ? 'filled' : 'light'}>
      {status}
    </Badge>
  )
}
