import { useCallback, useEffect, useState } from 'react'
import { Alert, Badge, Button, Drawer, Group, Stack, Text, TextInput, Textarea } from '@mantine/core'
import type { SkillDetail } from '@ctxlayer/shared'
import { KV, Section } from '../../components/admin-bits'
import { deleteSkill, fetchSkill, patchSkill, skillExportUrl } from '../../lib/api'
import { useBusyAction } from '../../lib/use-busy'
import { useDialogs, useDrawerConfirm } from '../../lib/dialogs'
import { explain } from './helpers'
import { AttachManager } from './AttachManager'
import { DrafterMetaCard } from './DrafterMetaCard'

export function SkillDrawer({
  skillId,
  isAdmin,
  onClose,
  onChanged,
  onOpenEditor
}: {
  skillId: string
  // Attaching a skill to an upstream is admin-only (it fans onto every
  // tool description) — the Attachments section renders only for admins.
  isAdmin: boolean
  onClose: () => void
  onChanged: () => void
  onOpenEditor: (id: string) => void
}) {
  const { alert } = useDialogs()
  const { hidden, confirm, reveal } = useDrawerConfirm()
  const [detail, setDetail] = useState<SkillDetail | null>(null)
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

  const { busy, run: withBusy } = useBusyAction({
    explain,
    setError,
    onStart: () => setInfo(null)
  })

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
        const ok = await confirm({
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

  const setVisibility = (next: 'private' | 'org') =>
    withBusy(async () => {
      // "Shared" means live to the org — flip visibility AND publish in one
      // move so a freshly-shared skill actually surfaces. "Private" only
      // narrows the audience; it leaves the lifecycle status untouched.
      await patchSkill(
        skillId,
        next === 'org' ? { visibility: 'org', status: 'published' } : { visibility: 'private' }
      )
      await load()
      onChanged()
    }, 'Sharing change')

  const remove = async () => {
    // The confirm slides this drawer out of the way and back on cancel
    // (useDrawerConfirm); keepHiddenOnConfirm holds it hidden through the
    // delete so it doesn't flash back before unmounting.
    const ok = await confirm(
      {
        title: 'Delete skill?',
        message:
          'Soft-deletes the skill. Body + revisions remain in storage; admins can no longer find it via the SPA.',
        confirmLabel: 'Delete',
        danger: true
      },
      { keepHiddenOnConfirm: true }
    )
    if (!ok) return
    try {
      await deleteSkill(skillId)
      onChanged()
      onClose()
    } catch (err) {
      reveal() // delete failed — bring the drawer back so the error is visible
      await alert({ title: 'Delete failed', message: explain(err) })
    }
  }

  if (!detail && !error) {
    return (
      <Drawer
        opened={!hidden}
        onClose={onClose}
        title="Skill · loading…"
        position="right"
        size="md"
        padding="md"
      >
        <Text c="dimmed">Loading…</Text>
      </Drawer>
    )
  }

  return (
    <Drawer
      opened={!hidden}
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
          <Alert
            color="green"
            variant="light"
            radius="sm"
            withCloseButton
            onClose={() => setInfo(null)}
          >
            {info}
          </Alert>
        )}

        {detail && (
          <>
            <DrafterMetaCard meta={detail.drafterMeta} />
            {usedUpstreams(detail).length > 0 && (
              <Section title="Uses upstreams">
                <Group gap={6}>
                  {usedUpstreams(detail).map((s) => (
                    <Badge key={s} variant="light" color="blue" size="sm">
                      {s}
                    </Badge>
                  ))}
                </Group>
                <Text fz="xs" c="dimmed" mt={4}>
                  Agents are warned when they can't reach one of these.
                </Text>
              </Section>
            )}
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

            <Section title="Sharing">
              <Stack gap="xs">
                <Text fz="xs" c="dimmed">
                  {visibilityHint(detail)}
                </Text>
                <Group gap="xs">
                  <Button
                    size="xs"
                    variant={detail.visibility === 'private' ? 'filled' : 'default'}
                    color="gray"
                    onClick={() => setVisibility('private')}
                    disabled={busy || detail.visibility === 'private'}
                  >
                    Private
                  </Button>
                  <Button
                    size="xs"
                    variant={detail.visibility === 'org' ? 'filled' : 'default'}
                    color="blue"
                    onClick={() => setVisibility('org')}
                    disabled={busy || (detail.visibility === 'org' && detail.status === 'published')}
                  >
                    Shared with org
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

            {isAdmin && (
              <Section title="Attachments">
                <AttachManager
                  skillId={skillId}
                  attachments={detail.attachments}
                  declaredUpstreams={usedUpstreams(detail)}
                  confirm={confirm}
                  onChanged={async () => {
                    await load()
                    onChanged()
                  }}
                />
              </Section>
            )}

            <Section title="Body">
              <Stack gap="xs">
                <Text fz="xs" c="dimmed">
                  Edit the skill body in the full-page editor, or download it as a
                  <code style={{ fontSize: 11 }}> SKILL.md</code> for Claude Code.
                </Text>
                <Group justify="flex-end">
                  <Button
                    size="xs"
                    variant="default"
                    component="a"
                    href={skillExportUrl(skillId)}
                    download={`${detail.slug}.SKILL.md`}
                  >
                    Download SKILL.md
                  </Button>
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

/** Upstreams a skill declares it uses: its attachments plus the upstreams it
 *  was AI-drafted against (from the opaque drafterMeta). */
function usedUpstreams(d: SkillDetail): string[] {
  const fromAttach = d.attachments.map((a) => a.upstreamSlug)
  const meta = d.drafterMeta as { upstreams?: unknown } | null | undefined
  const fromDraft =
    meta && Array.isArray(meta.upstreams)
      ? (meta.upstreams as unknown[]).filter((s): s is string => typeof s === 'string')
      : []
  return [...new Set([...fromAttach, ...fromDraft])]
}

function visibilityHint(d: SkillDetail): string {
  if (d.visibility === 'private') return 'Private — only you (and admins) can see this skill.'
  if (d.status === 'published') return 'Shared — live to everyone in the org.'
  if (d.status === 'archived') return 'Shared, but archived (hidden from agents).'
  return 'Shared, but still a draft — publish it (Status) to surface it to the org.'
}
