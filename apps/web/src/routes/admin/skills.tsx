import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Alert,
  Badge,
  Button,
  Drawer,
  Group,
  Modal,
  Select,
  Stack,
  Text,
  TextInput,
  Textarea,
  Title
} from '@mantine/core'
import type {
  CreateSkillRequest,
  SkillAttachmentRef,
  SkillDetail,
  SkillSummary,
  UserUpstreamSummary
} from '@ctxlayer/shared'
import {
  ApiError,
  ApiSchemaError,
  attachSkill,
  createSkill,
  deleteSkill,
  detachSkill,
  fetchAdminUpstreamTools,
  fetchSkill,
  fetchSkills,
  fetchUpstreams,
  patchSkill
} from '../../lib/api'
import { useDialogs } from '../../lib/dialogs'

type StatusFilter = 'all' | 'draft' | 'published' | 'archived'

export function AdminSkills() {
  const [items, setItems] = useState<SkillSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [query, setQuery] = useState('')
  const nav = useNavigate()

  const reload = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const list = await fetchSkills(
          { status: statusFilter === 'all' ? undefined : statusFilter },
          signal
        )
        if (!signal?.aborted) setItems(list)
      } catch (err) {
        if (!signal?.aborted) setError(explain(err))
      }
    },
    [statusFilter]
  )

  useEffect(() => {
    const ctrl = new AbortController()
    reload(ctrl.signal)
    return () => ctrl.abort()
  }, [reload])

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
                <td style={{ fontWeight: 500 }}>{s.title}</td>
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
  const colour =
    status === 'published' ? 'green' : status === 'draft' ? 'yellow' : 'gray'
  return (
    <Badge color={colour} variant={status === 'published' ? 'filled' : 'light'}>
      {status}
    </Badge>
  )
}

// ----- Create modal ------------------------------------------------------

function CreateSkillModal({
  onClose,
  onCreated
}: {
  onClose: () => void
  onCreated: (id: string) => void
}) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    if (!title.trim() || !description.trim()) {
      setError('Title and description are required.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const input: CreateSkillRequest = {
        title: title.trim(),
        description: description.trim()
      }
      const { id } = await createSkill(input)
      onCreated(id)
    } catch (err) {
      setError(explain(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal opened onClose={onClose} title="New skill" size="md">
      <Stack gap="md">
        {error && (
          <Alert color="red" variant="light" radius="sm">
            {error}
          </Alert>
        )}
        <TextInput
          label="Title"
          placeholder="e.g. Linear customer-bug triage"
          value={title}
          onChange={(e) => setTitle(e.currentTarget.value)}
          required
          autoFocus
        />
        <Textarea
          label="Description"
          description="One-line trigger: when should the agent use this skill?"
          placeholder="When a customer reports a bug, file it in Linear ENG with the triage label."
          value={description}
          onChange={(e) => setDescription(e.currentTarget.value)}
          minRows={2}
          required
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} loading={busy}>
            Create draft
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}

// ----- Drawer ------------------------------------------------------------

function SkillDrawer({
  skillId,
  onClose,
  onChanged,
  onOpenEditor
}: {
  skillId: string
  onClose: () => void
  onChanged: () => void
  onOpenEditor: (id: string) => void
}) {
  const dialogs = useDialogs()
  const [detail, setDetail] = useState<SkillDetail | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [draftTitle, setDraftTitle] = useState('')
  const [draftDesc, setDraftDesc] = useState('')
  const [draftTrigger, setDraftTrigger] = useState('')

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const d = await fetchSkill(skillId, signal)
        if (signal?.aborted) return
        setDetail(d)
        setDraftTitle(d.title)
        setDraftDesc(d.description)
        setDraftTrigger(d.triggerText)
      } catch (err) {
        if (!signal?.aborted) setError(explain(err))
      }
    },
    [skillId]
  )

  useEffect(() => {
    const ctrl = new AbortController()
    load(ctrl.signal)
    return () => ctrl.abort()
  }, [load])

  async function withBusy(fn: () => Promise<void>, label: string) {
    setBusy(true)
    setError(null)
    setInfo(null)
    try {
      await fn()
    } catch (err) {
      setError(`${label} failed: ${explain(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const saveMetadata = () =>
    withBusy(async () => {
      const patch: Record<string, string> = {}
      if (draftTitle.trim() && draftTitle !== detail?.title) patch.title = draftTitle.trim()
      if (draftDesc.trim() && draftDesc !== detail?.description)
        patch.description = draftDesc.trim()
      if (draftTrigger !== detail?.triggerText) patch.triggerText = draftTrigger
      if (Object.keys(patch).length === 0) {
        setInfo('No changes to save.')
        return
      }
      await patchSkill(skillId, patch)
      setInfo('Saved.')
      await load()
      onChanged()
    }, 'Save metadata')

  const setStatus = (next: 'draft' | 'published' | 'archived') =>
    withBusy(async () => {
      if (detail?.status === 'published' && next !== 'published') {
        const ok = await dialogs.confirm({
          title: `Move out of published?`,
          message: `This skill is currently live. Setting it to "${next}" hides it from list_skills and the CLI export.`,
          confirmLabel: 'Yes, change status',
          danger: true
        })
        if (!ok) return
      }
      await patchSkill(skillId, { status: next })
      await load()
      onChanged()
    }, 'Status change')

  const remove = () =>
    withBusy(async () => {
      const ok = await dialogs.confirm({
        title: 'Delete skill?',
        message: 'Soft-deletes the skill. Body + revisions remain in storage; admins can no longer find it via the SPA.',
        confirmLabel: 'Delete',
        danger: true
      })
      if (!ok) return
      await deleteSkill(skillId)
      onChanged()
      onClose()
    }, 'Delete')

  if (!detail && !error) {
    return (
      <Drawer opened onClose={onClose} title="Skill · loading…" position="right" size="md" padding="md">
        <Text c="dimmed">Loading…</Text>
      </Drawer>
    )
  }

  return (
    <Drawer
      opened
      onClose={onClose}
      title={detail ? `Skill · ${detail.title}` : 'Skill'}
      position="right"
      size="md"
      padding="md"
    >
      <Stack gap="md">
        {error && (
          <Alert color="red" variant="light" radius="sm">
            {error}
          </Alert>
        )}
        {info && (
          <Alert color="green" variant="light" radius="sm" withCloseButton onClose={() => setInfo(null)}>
            {info}
          </Alert>
        )}

        {detail && (
          <>
            <Section title="Identity">
              <Stack gap="xs">
                <TextInput
                  label="Title"
                  value={draftTitle}
                  onChange={(e) => setDraftTitle(e.currentTarget.value)}
                  disabled={busy}
                />
                <Textarea
                  label="Description"
                  description="When should the agent invoke this skill?"
                  value={draftDesc}
                  onChange={(e) => setDraftDesc(e.currentTarget.value)}
                  minRows={2}
                  disabled={busy}
                />
                <Textarea
                  label="Trigger hints"
                  description="Optional extra 'when X' hints. Appended before the body."
                  value={draftTrigger}
                  onChange={(e) => setDraftTrigger(e.currentTarget.value)}
                  minRows={2}
                  disabled={busy}
                />
                <KV k="Slug" v={<code style={{ fontSize: 11 }}>{detail.slug}</code>} />
                <Group justify="flex-end">
                  <Button size="xs" onClick={saveMetadata} loading={busy}>
                    Save metadata
                  </Button>
                </Group>
              </Stack>
            </Section>

            <Section title="Status">
              <Group gap="xs">
                {(['draft', 'published', 'archived'] as const).map((s) => (
                  <Button
                    key={s}
                    size="xs"
                    variant={detail.status === s ? 'filled' : 'default'}
                    color={s === 'published' ? 'green' : s === 'draft' ? 'yellow' : 'gray'}
                    onClick={() => setStatus(s)}
                    disabled={busy || detail.status === s}
                  >
                    {s}
                  </Button>
                ))}
              </Group>
            </Section>

            <Section title="Attachments">
              <AttachManager
                skillId={skillId}
                attachments={detail.attachments}
                onChanged={async () => {
                  await load()
                  onChanged()
                }}
              />
            </Section>

            <Section title="Body">
              <Stack gap="xs">
                <Text fz="xs" c="dimmed">
                  Edit the skill body in the full-page editor.
                </Text>
                <Group justify="flex-end">
                  <Button size="xs" onClick={() => onOpenEditor(skillId)}>
                    Open editor
                  </Button>
                </Group>
              </Stack>
            </Section>

            <Section title="Danger zone">
              <Group justify="flex-end">
                <Button size="xs" variant="default" color="red" onClick={remove} disabled={busy}>
                  Delete skill
                </Button>
              </Group>
            </Section>
          </>
        )}
      </Stack>
    </Drawer>
  )
}

// ----- AttachManager (skill-anchored) ------------------------------------

function AttachManager({
  skillId,
  attachments,
  onChanged
}: {
  skillId: string
  attachments: SkillAttachmentRef[]
  onChanged: () => Promise<void>
}) {
  const dialogs = useDialogs()
  const [upstreams, setUpstreams] = useState<UserUpstreamSummary[] | null>(null)
  const [selectedUpstreamId, setSelectedUpstreamId] = useState<string | null>(null)
  const [tools, setTools] = useState<{ value: string; label: string }[]>([])
  const [selectedTool, setSelectedTool] = useState<string>('') // '' = whole upstream
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchUpstreams()
      .then((rows) => {
        if (!cancelled) setUpstreams(rows)
      })
      .catch((err) => !cancelled && setError(explain(err)))
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!selectedUpstreamId) {
      setTools([])
      setSelectedTool('')
      return
    }
    let cancelled = false
    fetchAdminUpstreamTools(selectedUpstreamId)
      .then((res) => {
        if (cancelled) return
        setTools([
          { value: '', label: '— whole upstream —' },
          ...res.tools.map((t) => ({ value: t.toolName, label: t.toolName }))
        ])
        setSelectedTool('')
      })
      .catch((err) => !cancelled && setError(explain(err)))
    return () => {
      cancelled = true
    }
  }, [selectedUpstreamId])

  const upstreamOptions = useMemo(
    () =>
      (upstreams ?? []).map((u) => ({
        value: u.id,
        label: `${u.displayName} (${u.slug})`
      })),
    [upstreams]
  )

  async function add() {
    if (!selectedUpstreamId) return
    setBusy(true)
    setError(null)
    try {
      await attachSkill({
        skillId,
        upstreamId: selectedUpstreamId,
        toolName: selectedTool || undefined
      })
      setSelectedUpstreamId(null)
      setSelectedTool('')
      await onChanged()
    } catch (err) {
      setError(explain(err))
    } finally {
      setBusy(false)
    }
  }

  async function remove(att: SkillAttachmentRef) {
    const ok = await dialogs.confirm({
      title: 'Remove attachment?',
      message: `Detach this skill from ${att.upstreamSlug}${att.toolName ? `.${att.toolName}` : ''}?`,
      confirmLabel: 'Detach',
      danger: true
    })
    if (!ok) return
    setBusy(true)
    setError(null)
    try {
      await detachSkill({
        skillId,
        upstreamId: att.upstreamId,
        toolName: att.toolName || undefined
      })
      await onChanged()
    } catch (err) {
      setError(explain(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Stack gap="xs">
      {error && (
        <Alert color="red" variant="light" radius="sm">
          {error}
        </Alert>
      )}
      {attachments.length === 0 ? (
        <Text fz="xs" c="dimmed">
          Not attached to any upstream yet.
        </Text>
      ) : (
        <Stack gap={4}>
          {attachments.map((a) => (
            <Group
              key={`${a.upstreamId}/${a.toolName}`}
              justify="space-between"
              px="sm"
              py={6}
              style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}
            >
              <div>
                <Text fz="sm">
                  <code>{a.upstreamSlug}</code>
                  {a.toolName ? (
                    <>
                      {' · '}
                      <code>{a.toolName}</code>
                    </>
                  ) : (
                    <Text component="span" fz="xs" c="dimmed">
                      {' '}
                      (whole upstream)
                    </Text>
                  )}
                </Text>
              </div>
              <Button
                size="xs"
                variant="subtle"
                color="red"
                onClick={() => remove(a)}
                disabled={busy}
              >
                Detach
              </Button>
            </Group>
          ))}
        </Stack>
      )}
      <Group gap="xs" align="flex-end">
        <Select
          size="xs"
          label="Upstream"
          placeholder="Pick an upstream"
          data={upstreamOptions}
          value={selectedUpstreamId}
          onChange={setSelectedUpstreamId}
          searchable
          clearable
          w={220}
        />
        <Select
          size="xs"
          label="Tool"
          placeholder="(whole upstream)"
          data={tools}
          value={selectedTool}
          onChange={(v) => setSelectedTool(v ?? '')}
          disabled={!selectedUpstreamId}
          w={220}
        />
        <Button size="xs" onClick={add} disabled={!selectedUpstreamId || busy}>
          Attach
        </Button>
      </Group>
    </Stack>
  )
}

// ----- helpers -----------------------------------------------------------

function Section({ title, children }: { title: string; children: React.ReactNode }) {
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

function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <Group gap="xs" wrap="nowrap" align="baseline">
      <Text fz="xs" c="dimmed" w={80}>
        {k}
      </Text>
      <Text fz="sm" style={{ minWidth: 0 }}>
        {v}
      </Text>
    </Group>
  )
}

function relativeTime(ts: number | null): string {
  if (!ts) return '—'
  const now = Math.floor(Date.now() / 1000)
  const delta = now - ts
  if (delta < 60) return `${delta}s ago`
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`
  if (delta < 86400 * 30) return `${Math.floor(delta / 86400)}d ago`
  return new Date(ts * 1000).toLocaleDateString()
}

function explain(err: unknown): string {
  if (err instanceof ApiError && err.status === 401)
    return 'Your session expired. Refresh to sign in again.'
  if (err instanceof ApiError && err.status === 403) return 'Admin permission required.'
  if (err instanceof ApiError && err.status === 404) return 'Not found.'
  if (err instanceof ApiError && err.status === 409) return 'Slug already taken — pick another.'
  if (err instanceof ApiError && err.status === 400) {
    return apiErrorBodyMessage(err) ?? 'Server rejected the request.'
  }
  if (err instanceof ApiError) return `Server returned HTTP ${err.status}.`
  if (err instanceof ApiSchemaError) return 'Server returned an unexpected response shape.'
  if (err instanceof Error) return err.message
  return 'Could not reach the server.'
}

function apiErrorBodyMessage(err: ApiError): string | null {
  const body = err.body as { error?: string; hint?: string; message?: string } | null | undefined
  if (!body || typeof body !== 'object') return null
  if (typeof body.hint === 'string' && body.hint) return body.hint
  if (typeof body.message === 'string' && body.message) return body.message
  if (typeof body.error === 'string' && body.error) return body.error
  return null
}
