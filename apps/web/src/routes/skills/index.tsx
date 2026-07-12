import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Alert, Button, Group, Text, TextInput, Title } from '@mantine/core'
import { clickableRow } from '../../lib/a11y'
import { fetchMe, fetchSkills, skillsBundleUrl } from '../../lib/api'
import { relativeTime } from '../../lib/time'
import { useLoad } from '../../lib/use-load'
import { explain } from './helpers'
import { CreateSkillModal } from './CreateSkillModal'
import { SkillDrawer } from './SkillDrawer'
import { StatusBadge, VisibilityBadge } from './badges'

/**
 * User-facing skills area (/app/skills). Everyone — not just admins — can
 * author here: the list shows the caller's own skills (private drafts
 * included) plus the org-shared library, and the drawer's Private↔Shared
 * control lets an owner share their own. Attaching a skill to an upstream
 * stays admin-only (the drawer hides it for non-admins).
 */
export function SkillsHome() {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [query, setQuery] = useState('')
  const nav = useNavigate()

  // Role gates only the admin-only Attachments section in the drawer; the
  // list + authoring work for everyone.
  const { data: me } = useLoad((signal) => fetchMe(signal), [], { explain })
  const isAdmin = me?.role === 'admin'

  const {
    data: items,
    error,
    reload
  } = useLoad((signal) => fetchSkills({}, signal), [], { explain })

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
        <div>
          <Title order={2} fz={20} fw={600}>
            Skills
          </Title>
          <Text fz="sm" c="dimmed">
            Reusable playbooks your agent can load. Draft privately, then share with the org.
          </Text>
        </div>
        <Group gap="xs">
          <TextInput
            size="xs"
            aria-label="Filter skills"
            placeholder="Filter by title or slug…"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            w={260}
          />
          <Button
            size="xs"
            variant="default"
            component="a"
            href={skillsBundleUrl()}
            download
            title="Download every published skill as a zip of SKILL.md files (unzip into ~/.claude/skills/)"
          >
            Download library
          </Button>
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
          No skills yet. Click <b>New skill</b> to create your first private draft.
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
              <th>Sharing</th>
              <th>Status</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((s) => (
              <tr key={s.id} {...clickableRow(() => setEditingId(s.id))}>
                <td style={{ fontWeight: 500 }}>{s.title}</td>
                <td className="text-muted">
                  <code style={{ fontSize: 11 }}>{s.slug}</code>
                </td>
                <td>
                  <VisibilityBadge visibility={s.visibility} />
                </td>
                <td>
                  <StatusBadge status={s.status} />
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
          isAdmin={!!isAdmin}
          onClose={() => setEditingId(null)}
          onChanged={() => reload()}
          onOpenEditor={(id) => {
            setEditingId(null)
            nav(`/app/skills/${id}/edit`)
          }}
        />
      )}

      {creating && (
        <CreateSkillModal
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false)
            nav(`/app/skills/${id}/edit`)
          }}
        />
      )}
    </>
  )
}
