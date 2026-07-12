import { useMemo, useState } from 'react'
import { Alert, Button, Group, Select, Stack, Text } from '@mantine/core'
import type { SkillAttachmentRef } from '@ctxlayer/shared'
import { attachSkill, detachSkill, fetchAdminUpstreamTools, fetchUpstreams } from '../../lib/api'
import { useLoad } from '../../lib/use-load'
import type { ConfirmOpts } from '../../lib/dialogs'
import { explain } from './helpers'

export function AttachManager({
  skillId,
  attachments,
  declaredUpstreams = [],
  onChanged,
  confirm
}: {
  skillId: string
  attachments: SkillAttachmentRef[]
  // Upstream slugs the skill declares it uses (its attachments ∪ the
  // upstreams it was AI-drafted against). The ones not yet attached become
  // one-click "attach" suggestions — closing the non-admin author → admin
  // approve loop without a separate request workflow.
  declaredUpstreams?: string[]
  onChanged: () => Promise<void>
  // The parent SkillDrawer's hiding confirm — slides the drawer away while the
  // detach dialog is up (a plain confirm here would be painted over by it).
  confirm: (opts: ConfirmOpts) => Promise<boolean>
}) {
  const [selectedUpstreamId, setSelectedUpstreamId] = useState<string | null>(null)
  const [selectedTool, setSelectedTool] = useState<string>('') // '' = whole upstream
  const [busy, setBusy] = useState(false)
  // One error channel shared by the loads and the attach/detach actions.
  const [error, setError] = useState<string | null>(null)

  const { data: upstreams } = useLoad((signal) => fetchUpstreams(signal), [], {
    explain,
    onError: setError
  })

  const { data: tools } = useLoad(
    async (signal) => {
      if (!selectedUpstreamId) {
        setSelectedTool('')
        return []
      }
      const res = await fetchAdminUpstreamTools(selectedUpstreamId, signal)
      if (!signal?.aborted) setSelectedTool('')
      return [
        { value: '', label: '— whole upstream —' },
        ...res.tools.map((t) => ({ value: t.toolName, label: t.toolName }))
      ]
    },
    [selectedUpstreamId],
    { explain, onError: setError }
  )

  const upstreamOptions = useMemo(
    () =>
      (upstreams ?? []).map((u) => ({
        value: u.id,
        label: `${u.displayName} (${u.slug})`
      })),
    [upstreams]
  )

  // Declared-but-not-yet-attached upstreams that exist in the visible set,
  // deduped — rendered as one-click whole-upstream attach suggestions.
  const suggestions = useMemo(() => {
    const attached = new Set(attachments.map((a) => a.upstreamSlug))
    const bySlug = new Map((upstreams ?? []).map((u) => [u.slug, u]))
    const seen = new Set<string>()
    const out: { slug: string; id: string }[] = []
    for (const slug of declaredUpstreams) {
      if (attached.has(slug) || seen.has(slug)) continue
      const u = bySlug.get(slug)
      if (!u) continue
      seen.add(slug)
      out.push({ slug, id: u.id })
    }
    return out
  }, [attachments, upstreams, declaredUpstreams])

  async function attachWholeUpstream(upstreamId: string) {
    setBusy(true)
    setError(null)
    try {
      await attachSkill({ skillId, upstreamId, toolName: undefined })
      await onChanged()
    } catch (err) {
      setError(explain(err))
    } finally {
      setBusy(false)
    }
  }

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
      {suggestions.length > 0 && (
        <Stack gap={4}>
          <Text fz="xs" c="dimmed">
            Drafted for these upstreams — attach so agents see it on <code>list_upstreams</code>:
          </Text>
          <Group gap="xs">
            {suggestions.map((s) => (
              <Button
                key={s.id}
                size="xs"
                variant="light"
                onClick={() => attachWholeUpstream(s.id)}
                disabled={busy}
              >
                + {s.slug}
              </Button>
            ))}
          </Group>
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
          data={tools ?? []}
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
