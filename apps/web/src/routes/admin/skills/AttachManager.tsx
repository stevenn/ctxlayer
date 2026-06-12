import { useEffect, useMemo, useState } from 'react'
import { Alert, Button, Group, Select, Stack, Text } from '@mantine/core'
import type { SkillAttachmentRef, UserUpstreamSummary } from '@ctxlayer/shared'
import {
  attachSkill,
  detachSkill,
  fetchAdminUpstreamTools,
  fetchUpstreams
} from '../../../lib/api'
import type { ConfirmOpts } from '../../../lib/dialogs'
import { explain } from './helpers'

export function AttachManager({
  skillId,
  attachments,
  onChanged,
  confirm
}: {
  skillId: string
  attachments: SkillAttachmentRef[]
  onChanged: () => Promise<void>
  // The parent SkillDrawer's hiding confirm — slides the drawer away while the
  // detach dialog is up (a plain confirm here would be painted over by it).
  confirm: (opts: ConfirmOpts) => Promise<boolean>
}) {
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
    const ok = await confirm({
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
